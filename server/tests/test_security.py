import io
import zipfile

import httpx
import pytest
from conftest import PW, login, new_client
from fastapi.testclient import TestClient
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app import auth, crypto, db, health, main, paperless


@pytest.fixture(autouse=True)
def fresh_limits():
    auth.reset_limits()
    yield
    auth.reset_limits()


def fail_login(client, username, n):
    return [client.post("/api/auth/login", json={"username": username, "password": "nope"}).status_code for _ in range(n)]


# ---------- CSRF

def test_cross_site_and_same_site_requests_are_refused(c):
    for site in ("cross-site", "same-site"):
        r = c.put("/api/profile", json={"name": "x"}, headers={"Sec-Fetch-Site": site})
        assert r.status_code == 403, site
    for site in ("same-origin", "none"):
        assert c.put("/api/profile", json={"name": "x"}, headers={"Sec-Fetch-Site": site}).status_code == 204


def test_without_sec_fetch_site_the_app_header_is_needed(c):
    bare = TestClient(main.app, cookies=c.cookies)  # no X-Requested-With
    assert bare.put("/api/profile", json={"name": "x"}).status_code == 403
    assert bare.post("/api/auth/login", json={"username": "anna", "password": PW}).status_code == 403
    assert bare.put("/api/profile", json={"name": "x"}, headers={"X-Requested-With": "XMLHttpRequest"}).status_code == 403
    assert bare.get("/api/profile").status_code == 200  # reading is not a change


def test_shortcut_route_needs_no_app_header(c):
    token = c.post("/api/me/ingest-token").json()["token"]
    bare = TestClient(main.app)
    assert bare.post("/api/ingest/health", json={}, headers={"Authorization": f"Bearer {token}"}).status_code == 200


# ---------- Password guessing

def test_password_guessing_is_blocked(c):
    x = new_client()
    assert fail_login(x, "anna", auth.LOGIN_USER.limit) == [401] * auth.LOGIN_USER.limit
    r = x.post("/api/auth/login", json={"username": "anna", "password": PW})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_lockout_is_per_address_and_username(c):
    attacker = new_client(client=("203.0.113.9", 5000))
    fail_login(attacker, "anna", auth.LOGIN_USER.limit)
    assert attacker.post("/api/auth/login", json={"username": "anna", "password": PW}).status_code == 429
    # Anna, from her own address, can still log in.
    login("anna", client=("198.51.100.7", 5000))
    # The attacker can try another username (until the per-address limit).
    assert attacker.post("/api/auth/login", json={"username": "bob", "password": "x"}).status_code == 401


def test_per_address_soft_limit(c):
    x = new_client(client=("203.0.113.10", 5000))
    codes = [x.post("/api/auth/login", json={"username": f"user{i}", "password": "x"}).status_code
             for i in range(auth.LOGIN_IP.limit + 1)]
    assert codes[-1] == 429 and codes[:-1] == [401] * auth.LOGIN_IP.limit


def test_spoofed_x_forwarded_for_is_ignored(c):
    # Uvicorn (as in the image) trusts X-Forwarded-For only from FORWARDED_ALLOW_IPS, default 127.0.0.1.
    proxied = TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="127.0.0.1"),
                         headers={"X-Requested-With": "health-diary"}, client=("203.0.113.11", 5000))
    codes = [proxied.post("/api/auth/login", json={"username": "anna", "password": "nope"},
                          headers={"X-Forwarded-For": f"10.0.0.{i}", "X-Forwarded-Proto": "https"}).status_code
             for i in range(auth.LOGIN_USER.limit + 1)]
    assert codes[-1] == 429
    # A trusted proxy's header is used.
    trusted = TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="127.0.0.1"),
                         headers={"X-Requested-With": "health-diary"}, client=("127.0.0.1", 5000))
    r = trusted.post("/api/auth/login", json={"username": "anna", "password": PW},
                     headers={"X-Forwarded-For": "198.51.100.20", "X-Forwarded-Proto": "https"})
    assert r.status_code == 200


def test_secure_cookie_ignores_untrusted_forwarded_proto(monkeypatch):
    monkeypatch.setattr(auth, "COOKIE_SECURE", "auto")
    from starlette.requests import Request

    def req(host, scheme="http", headers=()):
        return Request({"type": "http", "scheme": scheme, "server": (host, 80), "path": "/",
                        "headers": [(b"host", host.encode()), *headers], "method": "GET", "query_string": b""})
    assert auth._is_https(req("diary.lan", headers=[(b"x-forwarded-proto", b"https")])) is False
    assert auth._is_https(req("diary.lan", scheme="https")) is True
    assert auth._is_https(req("health-diary.tail1234.ts.net")) is True


def test_limiter_table_is_pruned():
    lim = auth.Limiter(3, 60, max_keys=100)
    for i in range(1000):
        lim.hit(f"k{i}")
    assert len(lim._hits) == 100
    lim.window = -1  # everything is old
    assert lim.wait("k999") == 0 and "k999" not in lim._hits


# ---------- Request size

def test_large_json_body_is_refused(c):
    r = c.put("/api/profile", content=b"{" + b" " * (main.MAX_JSON + 10) + b"}",
              headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_streamed_body_without_length_is_counted(c):
    def chunks():
        for _ in range(20):
            yield b" " * 100_000
    r = c.put("/api/profile", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413


def test_import_size_limit(c, monkeypatch):
    monkeypatch.setattr(main, "MAX_IMPORT_MB", 1)
    big = b"x" * (1024 * 1024 + 1)
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", big, "application/zip")})
    assert r.status_code == 413 and "1 MB" in r.json()["detail"]
    assert list(db.TMP_DIR.iterdir()) == []


def test_anonymous_upload_writes_nothing(c):
    anon = new_client()
    r = anon.post("/api/import/apple-health", files={"file": ("export.zip", b"PK" + b"0" * 100_000, "application/zip")})
    assert r.status_code == 401
    assert list(db.TMP_DIR.iterdir()) == []
    assert db.TMP_DIR.stat().st_mode & 0o777 == 0o700


def test_upload_needs_a_file_field(c):
    assert c.post("/api/import/apple-health", files={"other": ("x", b"x")}).status_code == 400
    assert c.post("/api/import/apple-health", json={"a": 1}).status_code == 400


# ---------- Zip bombs and broken files

def bomb_zip(size):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/export.xml", b"<HealthData>" + b" " * size + b"</HealthData>")
    return buf.getvalue()


def test_zip_bomb_is_refused(c):
    data = bomb_zip(20 * 1024 * 1024)  # 20 MB of spaces packs to about 20 kB
    assert len(data) < 100_000
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", data, "application/zip")})
    assert r.status_code == 400 and "too much data" in r.json()["detail"]


def test_unpacked_size_is_capped_while_reading(tmp_path, monkeypatch):
    monkeypatch.setattr(health, "MAX_UNPACKED", 1000)
    p = tmp_path / "export.xml"
    p.write_bytes(b"<HealthData>" + b"<Record/>" * 500 + b"</HealthData>")
    with pytest.raises(health.ImportRefused):
        health.import_export(1, str(p))


def test_entity_expansion_is_refused(c):
    xml = b"""<?xml version="1.0"?><!DOCTYPE HealthData [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;">]>
<HealthData>&b;</HealthData>"""
    r = c.post("/api/import/apple-health", files={"file": ("export.xml", xml, "text/xml")})
    assert r.status_code == 400 and "aaaa" not in r.text


def test_broken_files_get_a_plain_message(c):
    for data in (b"not a zip", b"PK\x03\x04broken", b"<HealthData><Record"):
        r = c.post("/api/import/apple-health", files={"file": ("x.zip", data, "application/zip")})
        assert r.status_code == 400
        assert r.json()["detail"] == "Could not read this file. Upload the export.zip from the Health app."
    assert list(db.TMP_DIR.iterdir()) == []


# ---------- Paperless tokens

def test_paperless_token_is_encrypted(c):
    secret = "pl-secret-0123456789abcdef"
    cfg = c.put("/api/me/paperless", json={"token": secret, "tag": "medical"}).json()
    assert cfg["hasToken"] is True and cfg["tokenFromServer"] is False and secret not in str(cfg)
    uid = c.get("/api/auth/status").json()["user"]["id"]
    assert paperless.user_config(uid)[0] == secret  # round trip
    stored = db.get_kv(uid, "paperless", {})
    assert "token" not in stored and stored["tokenEnc"].startswith("v1:")
    for f in db.DATA_DIR.glob("diary.db*"):
        assert secret.encode() not in f.read_bytes(), f
    key = db.DATA_DIR / "secret.key"
    assert key.exists() and key.stat().st_mode & 0o777 == 0o600
    # An empty token removes it.
    assert c.put("/api/me/paperless", json={"token": ""}).json()["hasToken"] is False


def test_old_plain_tokens_are_encrypted_at_start(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    db.set_kv(uid, "paperless", {"token": "old-plain", "tag": "x"})
    paperless.encrypt_old_tokens()
    assert "token" not in db.get_kv(uid, "paperless", {})
    assert paperless.user_config(uid)[0] == "old-plain"


def test_wrong_key_does_not_crash(c, monkeypatch):
    blob = crypto.encrypt("abc")
    monkeypatch.setenv("DIARY_SECRET_KEY", "another key")
    crypto.init()
    try:
        assert crypto.decrypt(blob) is None
    finally:
        monkeypatch.delenv("DIARY_SECRET_KEY")
        crypto.init()
    assert crypto.decrypt(blob) == "abc"


def test_env_token_is_for_the_first_admin_only(c, monkeypatch):
    monkeypatch.setattr(paperless, "ENV_TOKEN", "from-env")
    anna = c.get("/api/auth/status").json()["user"]["id"]
    db.set_kv(anna, "paperless", {})
    assert paperless.user_config(anna) == ("from-env", "medical", True)
    c.post("/api/users", json={"username": "fred", "password": PW})
    fred = login("fred")
    assert fred.get("/api/me/paperless").json()["hasToken"] is False


def test_paperless_next_link_to_another_host_is_not_followed(monkeypatch):
    monkeypatch.setattr(paperless, "URL", "http://paperless.lan:8000")
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "paperless.lan":
            return httpx.Response(200, json={"results": [{"id": 1}], "next": "http://evil.example/steal"})
        return httpx.Response(200, json={"results": [{"id": 2}], "next": None})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert paperless._get_all(client, "/api/documents/") == [{"id": 1}]
    assert all("evil" not in u for u in seen)


def test_cache_is_cleared_when_settings_change(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    paperless._cache[uid] = (9e18, [{"id": 1}])
    c.put("/api/me/paperless", json={"tag": "other"})
    assert uid not in paperless._cache


# ---------- Errors

def test_unexpected_errors_are_generic(c, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("secret detail /data/diary.db")
    monkeypatch.setattr(db, "list_days", boom)
    x = TestClient(main.app, headers={"X-Requested-With": "health-diary"}, cookies=c.cookies,
                    raise_server_exceptions=False)
    r = x.get("/api/days")
    assert r.status_code == 500 and "secret" not in r.text


def test_shortcut_rate_limit(c):
    token = c.post("/api/me/ingest-token").json()["token"]
    codes = [c.post("/api/ingest/health", json={}, headers={"Authorization": f"Bearer {token}"}).status_code
             for _ in range(auth.INGEST.limit + 1)]
    assert codes[-1] == 429 and codes[0] == 200
