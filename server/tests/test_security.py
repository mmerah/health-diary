import io
import zipfile
from concurrent.futures import ThreadPoolExecutor

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
        assert c.put("/api/profile", json={"name": "x"}, headers={"Sec-Fetch-Site": site}).status_code == 200


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

class Clock:
    """A fake time.monotonic for the rate limits."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


@pytest.fixture
def clock(monkeypatch):
    clk = Clock()
    monkeypatch.setattr(auth.time, "monotonic", clk)
    return clk


def test_each_failure_doubles_the_wait(c, clock):
    x = new_client()
    waits = []
    for _ in range(9):
        assert x.post("/api/auth/login", json={"username": "anna", "password": "nope"}).status_code == 401
        r = x.post("/api/auth/login", json={"username": "anna", "password": PW})
        assert r.status_code == 429
        waits.append(int(r.headers["Retry-After"]))
        clock.now += waits[-1]
    assert waits == [2, 3, 5, 9, 17, 33, 61, 61, 61]  # 1, 2, 4 ... 60 s, rounded up
    # After the wait, the right password works and the count starts over.
    assert x.post("/api/auth/login", json={"username": "anna", "password": PW}).status_code == 200
    assert fail_login(x, "anna", 1) == [401]


def test_parallel_guesses_are_counted(c):
    def guess(i):
        return new_client(client=("203.0.113.40", 6000 + i)).post(
            "/api/auth/login", json={"username": "anna", "password": "nope"}).status_code
    with ThreadPoolExecutor(max_workers=40) as pool:
        codes = list(pool.map(guess, range(40)))
    assert codes.count(401) == 1 and codes.count(429) == 39


def test_lockout_is_per_address_and_username(c):
    attacker = new_client(client=("203.0.113.9", 5000))
    fail_login(attacker, "anna", 1)
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


def test_a_refused_try_is_not_counted(c, clock):
    """When the per-address limit refuses, the username backoff does not grow."""
    x = new_client(client=("203.0.113.12", 5000))
    for i in range(auth.LOGIN_IP.limit):
        x.post("/api/auth/login", json={"username": f"u{i}", "password": "x"})
    assert x.post("/api/auth/login", json={"username": "anna", "password": "x"}).status_code == 429
    assert "203.0.113.12|anna" not in auth.LOGIN_USER._state


def test_spoofed_x_forwarded_for_is_ignored(c):
    # Uvicorn (as in the image) trusts X-Forwarded-For only from FORWARDED_ALLOW_IPS, default 127.0.0.1.
    proxied = TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="127.0.0.1"),
                         headers={"X-Requested-With": "health-diary"}, client=("203.0.113.11", 5000))
    codes = [proxied.post("/api/auth/login", json={"username": "anna", "password": "nope"},
                          headers={"X-Forwarded-For": f"10.0.0.{i}", "X-Forwarded-Proto": "https"}).status_code
             for i in range(3)]
    assert codes == [401, 429, 429]  # a new X-Forwarded-For each time does not reset the wait
    # A trusted proxy's header is used.
    trusted = TestClient(ProxyHeadersMiddleware(main.app, trusted_hosts="127.0.0.1"),
                         headers={"X-Requested-With": "health-diary"}, client=("127.0.0.1", 5000))
    r = trusted.post("/api/auth/login", json={"username": "anna", "password": PW},
                     headers={"X-Forwarded-For": "198.51.100.20", "X-Forwarded-Proto": "https"})
    assert r.status_code == 200


def test_secure_cookie_ignores_untrusted_forwarded_proto(monkeypatch):
    from starlette.requests import Request

    def req(host, scheme="http", headers=()):
        return Request({"type": "http", "scheme": scheme, "server": (host, 80), "path": "/",
                        "headers": [(b"host", host.encode()), *headers], "method": "GET", "query_string": b""})
    assert auth._is_https(req("diary.lan", headers=[(b"x-forwarded-proto", b"https")])) is False
    assert auth._is_https(req("diary.lan", scheme="https")) is True
    assert auth._is_https(req("health-diary.tail1234.ts.net")) is True


def test_limit_tables_are_pruned(clock):
    lim, back = auth.Limiter(3, 60, max_keys=100), auth.Backoff(max_keys=100)
    for i in range(1000):
        lim.reserve(f"k{i}")
        back.reserve(f"k{i}")
    assert len(lim._hits) == 100 and len(back._state) == 100
    clock.now += 3600  # everything is old
    assert lim.reserve("k999") == 0 and len(lim._hits["k999"]) == 1
    assert back.reserve("k999") == 0 and back._state["k999"][0] == 1


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


def test_chunked_document_upload_over_the_limit_is_413(c, monkeypatch):
    from app import documents
    monkeypatch.setattr(documents, "MAX_DOC_MB", 1)

    def chunks():
        yield b"--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.pdf\"\r\n\r\n%PDF-"
        for _ in range(3):
            yield b"0" * (1024 * 1024)
        yield b"\r\n--b--\r\n"
    x = TestClient(main.app, headers={"X-Requested-With": "health-diary"}, cookies=c.cookies,
                   raise_server_exceptions=False)
    r = x.post("/api/documents", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=b"})
    assert r.status_code == 413 and r.json()["detail"] == "The file is too large. The limit is 1 MB."
    assert list(db.TMP_DIR.iterdir()) == []


def test_import_has_no_size_limit_but_needs_free_disk_space(c, monkeypatch):
    # Bigger than the 1 MB of the JSON routes: accepted (then refused as not an export).
    big = b"x" * (3 * 1024 * 1024)
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", big, "application/zip")})
    assert r.status_code == 400 and "Could not read this file" in r.json()["detail"]
    # Not enough room on the disk: refused before the upload is read.
    monkeypatch.setattr(db, "room", lambda: 1000)
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", big, "application/zip")})
    assert r.status_code == 507 and "free disk space" in r.json()["detail"]
    assert list(db.TMP_DIR.iterdir()) == []


def test_free_disk_space_is_checked_while_the_upload_arrives(c, monkeypatch):
    calls = []

    def room():
        calls.append(1)
        return 10 ** 12 if len(calls) == 1 else -1  # fine at the start, then the disk fills up
    monkeypatch.setattr(db, "room", room)

    def chunks():
        yield b"--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"e.zip\"\r\n\r\n"
        for _ in range(20):
            yield b"0" * (1024 * 1024)
        yield b"\r\n--b--\r\n"
    r = c.post("/api/import/apple-health", content=chunks(), headers={"Content-Type": "multipart/form-data; boundary=b"})
    assert r.status_code == 507 and len(calls) == 2
    assert list(db.TMP_DIR.iterdir()) == []


def test_room_keeps_a_reserve(monkeypatch):
    from collections import namedtuple
    usage = namedtuple("usage", "total used free")
    monkeypatch.setattr(db.shutil, "disk_usage", lambda p: usage(100 * 1024 ** 3, 0, 15 * 1024 ** 3))
    assert db.room() == 5 * 1024 ** 3  # 10% of a 100 GB disk is kept free
    monkeypatch.setattr(db.shutil, "disk_usage", lambda p: usage(4 * 1024 ** 3, 0, 3 * 1024 ** 3))
    assert db.room() == 2 * 1024 ** 3  # at least 1 GB is kept free


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


def test_unpacked_size_must_fit_on_the_disk(tmp_path, monkeypatch):
    p = tmp_path / "export.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/export.xml", b"<HealthData>" + b"<Record/>" * 500 + b"</HealthData>")
    monkeypatch.setattr(db, "room", lambda: 100)
    with pytest.raises(health.ImportRefused, match="free disk space"):
        health.import_export(1, str(p))


def test_reading_stops_at_the_declared_size():
    reader = health._Limited(io.BytesIO(b"x" * 5000), 1000)
    with pytest.raises(health.ImportRefused):
        while reader.read(400):
            pass


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
    cfg = c.put("/api/me/paperless", json={"token": secret, "tags": ["medical"]}).json()
    assert cfg["hasToken"] is True and "tokenFromServer" not in cfg and secret not in str(cfg)
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


def test_paperless_next_link_to_another_host_is_not_followed(monkeypatch):
    monkeypatch.setattr(paperless, "URL", "http://paperless.lan:8000")
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "paperless.lan":
            return httpx.Response(200, json={"results": [{"id": 1}], "next": "http://evil.example/steal"})
        return httpx.Response(200, json={"results": [{"id": 2}], "next": None})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(paperless.Partial) as e:
            paperless._get_all(client, "/api/documents/")
    assert e.value.items == [{"id": 1}] and "Check PAPERLESS_URL" in str(e.value)
    assert all("evil" not in u for u in seen)


def test_paperless_page_links_with_the_public_address_are_rebuilt(monkeypatch):
    # Behind a proxy, Paperless builds page links with its public address (and maybe a path prefix).
    monkeypatch.setattr(paperless, "URL", "http://10.0.0.5:8000")
    seen = []

    def handler(request):
        seen.append(str(request.url))
        page = request.url.params.get("page", "1")
        nxt = {"1": "https://paperless.example.com/api/documents/?page=2&page_size=100",
               "2": "https://paperless.example.com/paperless/api/documents/?page=3", "3": None}[page]
        return httpx.Response(200, json={"results": [{"id": int(page)}], "next": nxt})

    with httpx.Client(transport=httpx.MockTransport(handler)) as client:
        assert paperless._get_all(client, "/api/documents/") == [{"id": 1}, {"id": 2}, {"id": 3}]
    assert all(u.startswith("http://10.0.0.5:8000/api/documents/") for u in seen)
    assert seen[1].endswith("?page=2&page_size=100")


def test_cache_is_cleared_when_settings_change(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    paperless._cache[uid] = (9e18, [{"id": 1}])
    c.put("/api/me/paperless", json={"tags": ["other"]})
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
