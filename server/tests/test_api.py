import io
import json
import sqlite3
import zipfile

import pytest
from conftest import PW, login, new_client

from app import auth, db, main


def test_setup_needs_the_code(server):
    assert server.get("/api/auth/status").json() == {"setupNeeded": True, "user": None}
    assert server.post("/api/auth/setup", json={"code": "WRONG", "username": "anna", "password": PW}).status_code == 403
    assert server.post("/api/auth/setup", json={"code": "WRONG", "username": "anna", "password": PW}).status_code == 429
    auth.reset_limits()  # instead of waiting 1 s
    # 7 groups of 4 from a 31-symbol alphabet: more than 128 bits.
    groups = main.SETUP_CODE.split("-")
    assert len(groups) == 7 and all(len(g) == 4 and set(g) <= set(auth.SETUP_ALPHABET) for g in groups)
    # Case, spaces and dashes do not matter.
    code = main.SETUP_CODE.replace("-", " ").lower()
    r = server.post("/api/auth/setup", json={"code": code, "username": "anna", "password": PW})
    assert r.status_code == 200 and r.json()["isAdmin"] is True
    assert set(r.json()) == {"id", "username", "isAdmin", "hasIngestToken", "ingestLastUsed", "createdAt", "notice"}
    # A second setup is refused, even with the right code.
    r = new_client().post("/api/auth/setup", json={"code": main.SETUP_CODE, "username": "eve", "password": PW})
    assert r.status_code == 409


def test_second_account_is_never_made_by_setup(server):
    assert db.create_user("zed", auth.hash_password(PW), True, only_if_empty=True) is None


def test_index_and_config(server):
    r = new_client().get("/")
    assert r.status_code == 200
    assert r.text == (main.WEB_DIR / "index.html").read_text(encoding="utf-8")
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert "worker-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    assert r.headers["cache-control"] == "no-cache" and r.headers.get("etag")
    # The route wins over a static web/config.js (the demo settings).
    r = new_client().get("/config.js")
    assert "'/api'" in r.text and r.headers["content-type"].startswith("text/javascript")
    assert r.headers["cache-control"] == "no-cache"
    # Unchanged files answer 304, so no-cache stays cheap.
    etag = new_client().get("/").headers["etag"]
    assert new_client().get("/", headers={"If-None-Match": etag}).status_code == 304
    assert new_client().get("/api/health").headers["cache-control"] == "no-store"


def test_everything_needs_login(c):
    anon = new_client()
    for path in ["/api/profile", "/api/settings", "/api/days", "/api/days/2026-10-01", "/api/measurements",
                 "/api/documents", "/api/users", "/api/me/paperless", "/api/me/export"]:
        assert anon.get(path).status_code == 401, path
    assert anon.put("/api/profile", json={}).status_code == 401
    assert anon.post("/api/ingest/health", json={}).status_code == 401
    assert anon.get("/api/health").json()["ok"] is True


def test_profile(c):
    r = c.get("/api/profile")
    assert r.json() == {} and r.headers["x-version"] == "0"
    meds = [{"id": "m1", "name": "Ibuprofen", "dose": "200 mg", "since": "2026-01-02", "until": "", "asNeeded": True}]
    assert c.put("/api/profile", json={"name": "Test", "heightCm": 180, "medications": meds, "v": 2}).status_code == 200
    p = c.get("/api/profile").json()
    assert p == {"name": "Test", "heightCm": 180, "medications": meds, "v": 2}
    for bad in ({"heightCm": 20}, {"dob": "2026-02-31"}, {"sex": "x"}, {"name": "x" * 201}, {"unknown": 1},
                {"medications": [{"name": "x", "since": "yesterday"}]}, {"medications": [{}] * 51}):
        r = c.put("/api/profile", json=bad)
        assert r.status_code == 400, bad
        assert "Traceback" not in r.text


def test_settings(c):
    c.put("/api/settings", json={"redactWords": ["Clinic"]})
    c.put("/api/settings", json={"excludedDocs": [3], "lastSync": "2000-01-01T00:00"})
    s = c.get("/api/settings").json()
    assert s == {"lastSync": None, "redactWords": ["Clinic"], "excludedDocs": [3]}
    assert c.put("/api/settings", json={"redactWords": ["x"] * 301}).status_code == 400
    assert c.put("/api/settings", json={"theme": "dark"}).status_code == 400


LOG = {
    "v": 2,
    "meals": {"breakfast": {"time": "07:30", "text": "Eggs"}, "lunch": {"time": "", "text": ""}},
    "snacks": [{"time": "16:00", "text": "Apple"}],
    "drinks": {"water": 6, "coffee": 2, "alcohol": None},
    "meds": {"taken": {"m1": {"done": True, "time": "08:00"}}, "extra": [{"name": "Paracetamol", "time": "14:00"}]},
    "activities": "Walk",
    "symptoms": [{"name": "Headache", "severity": 2, "when": "periods", "periods": ["morning"], "from": "", "to": ""},
                 {"name": "Nausea", "severity": None, "when": "time", "periods": [], "from": "13:00", "to": "14:30"}],
    "notes": "ok",
}


def test_days(c):
    assert c.put("/api/days/2026-10-01/log", json=LOG).json() == {"logVersion": 1}
    assert c.get("/api/days/2026-10-01").json()["log"] == LOG
    assert [d["date"] for d in c.get("/api/days?from=2026-09-30&to=2026-10-02").json()] == ["2026-10-01"]
    assert c.get("/api/days/2026-13-1").status_code == 400
    assert c.get("/api/days/2026-02-30").status_code == 400


def test_log_versions(c):
    a = c.get("/api/days/2026-10-09").json()
    assert a == {"date": "2026-10-09", "log": None, "health": None, "logVersion": 0}
    # Phone and laptop both start from version 0. The phone saves first.
    assert c.put("/api/days/2026-10-09/log", json={"notes": "phone"}, headers={"X-Base-Version": "0"}).json() == {"logVersion": 1}
    r = c.put("/api/days/2026-10-09/log", json={"notes": "laptop"}, headers={"X-Base-Version": "0"})
    assert r.status_code == 409
    assert r.json() == {"detail": "This day was changed on another device.", "log": {"notes": "phone"}, "logVersion": 1}
    assert c.put("/api/days/2026-10-09/log", json={"notes": "both"}, headers={"X-Base-Version": "1"}).json() == {"logVersion": 2}
    # Without the header, a save is not checked.
    assert c.put("/api/days/2026-10-09/log", json={"notes": "old client"}).json() == {"logVersion": 3}
    assert c.put("/api/days/2026-10-09/log", json={}, headers={"X-Base-Version": "x"}).status_code == 400
    # Health data does not change the log version.
    c.put("/api/days/2026-10-09/health", json={"steps": 10})
    day = c.get("/api/days/2026-10-09").json()
    assert day["logVersion"] == 3 and day["health"]["steps"] == 10
    assert [d["logVersion"] for d in c.get("/api/days?from=2026-10-09&to=2026-10-09").json()] == [3]
    c.put("/api/days/2026-10-10/health", json={"steps": 10})
    assert c.get("/api/days/2026-10-10").json()["logVersion"] == 0


def test_profile_versions(c):
    v = int(c.get("/api/profile").headers["x-version"])
    assert c.put("/api/profile", json={"name": "A"}, headers={"X-Base-Version": str(v)}).json() == {"version": v + 1}
    r = c.put("/api/profile", json={"name": "B"}, headers={"X-Base-Version": str(v)})
    assert r.status_code == 409
    assert r.json() == {"detail": "Your profile was changed on another device.", "profile": {"name": "A"}, "version": v + 1}
    assert c.get("/api/profile").headers["x-version"] == str(v + 1)
    assert c.put("/api/profile", json={"name": "C"}).json() == {"version": v + 2}


def test_day_log_validation(c):
    bad = [
        {"v": 1},
        {"meals": {"breakfast": {"time": "7:30", "text": "x"}}},
        {"meals": {"lunch": {"time": "24:00", "text": "x"}}},
        {"snacks": [{"time": "", "text": "x"}] * 21},
        {"drinks": {"water": 1000}},
        {"drinks": {"coffee": -1}},
        {"symptoms": [{"name": "x", "severity": 4}]},
        {"symptoms": [{"name": "x", "periods": ["noon"]}]},
        {"notes": "x" * 10001},
        {"mood": "great"},
    ]
    for body in bad:
        assert c.put("/api/days/2026-10-01/log", json=body).status_code == 400, body


def test_day_health_validation(c):
    good = {"sleep": {"total": 400, "deep": 60, "rem": 80, "core": 260, "awake": 5, "bed": "23:00", "wake": "06:45",
                      "naps": [{"start": "14:00", "end": "14:30", "minutes": 30}], "inBedOnly": False},
            "steps": 8000, "restingHr": 60, "hrv": 40, "workouts": [{"type": "Walk", "minutes": 30, "start": None}],
            "source": "manual", "syncedAt": None, "edited": ["steps"]}
    assert c.put("/api/days/2026-10-05/health", json=good).status_code == 204
    assert c.get("/api/days/2026-10-05").json()["health"] == good
    for bad in ({"steps": -1}, {"restingHr": 400}, {"sleep": {"total": 2000}}, {"source": "fitbit"},
                {"sleep": {"bed": "25:00"}}, {"extra": True}):
        assert c.put("/api/days/2026-10-05/health", json=bad).status_code == 400, bad


def test_measurements(c):
    m = c.post("/api/measurements", json={"type": "temp", "date": "2026-10-02", "time": "21:00", "value": 38.2}).json()
    assert m["value"] == 38.2 and m["source"] == "manual"
    assert any(x["id"] == m["id"] for x in c.get("/api/measurements?type=temp").json())
    bp = c.post("/api/measurements", json={"type": "bp", "date": "2026-10-03", "time": "",
                                           "value": {"sys": 120, "dia": 80, "pulse": None}}).json()
    assert bp["value"] == {"sys": 120, "dia": 80, "pulse": None} and bp["time"] is None
    # A client cannot claim the value came from Apple Health.
    w = c.post("/api/measurements", json={"type": "weight", "date": "2026-10-04", "time": "07:00", "value": 70.5,
                                          "source": "apple"}).json()
    assert w["source"] == "manual"
    # Date filter
    assert [x["date"] for x in c.get("/api/measurements?from=2026-10-03&to=2026-10-03").json()] == ["2026-10-03"]
    for bad in ({"type": "height", "date": "2026-10-02", "value": 1},
                {"type": "weight", "date": "2026-10-02", "value": 3000},
                {"type": "weight", "date": "2026-02-30", "value": 70},
                {"type": "temp", "date": "2026-10-02", "value": 50},
                {"type": "bp", "date": "2026-10-02", "value": {"sys": 300, "dia": 80}},
                {"type": "weight", "date": "2026-10-02", "time": "7h", "value": 70}):
        assert c.post("/api/measurements", json=bad).status_code == 400, bad
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 204
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 404


def test_validation_errors_are_plain(c):
    r = c.post("/api/measurements", json={"type": "weight", "date": "2026-10-02", "value": "<script>"})
    assert r.status_code == 400
    assert "<script>" not in r.text and r.json()["detail"].startswith("Some values are not valid")


def test_documents_without_paperless(c):
    assert c.get("/api/documents").json() == {"documents": [], "paperless": {"ok": True, "error": None}}
    assert c.get("/api/me/paperless").json()["available"] is False


def test_users_are_isolated_and_managed_by_admin(c):
    assert c.post("/api/users", json={"username": "ben", "password": "short"}).status_code == 400
    ben_id = c.post("/api/users", json={"username": "ben", "password": PW}).json()["id"]
    assert c.post("/api/users", json={"username": "BEN", "password": PW}).status_code == 409
    ben = login("ben")

    assert ben.get("/api/days").json() == []
    assert ben.get("/api/profile").json() == {}
    m = ben.post("/api/measurements", json={"type": "weight", "date": "2026-10-03", "value": 70}).json()
    assert all(x["id"] != m["id"] for x in c.get("/api/measurements").json())
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 404

    assert ben.get("/api/users").status_code == 403
    assert ben.post("/api/users", json={"username": "x", "password": PW}).status_code == 403
    assert ben.put(f"/api/users/{ben_id}/admin", json={"isAdmin": True}).status_code == 403

    # A new password from the admin logs Ben out, and Ben sees a notice at the next login.
    assert c.put(f"/api/users/{ben_id}/password", json={"password": "another good one"}).status_code == 204
    assert ben.get("/api/profile").status_code == 401
    ben = login("ben", "another good one")
    notice = ben.get("/api/auth/status").json()["user"]["notice"]
    assert "reset your password" in notice and "anna" in notice
    assert ben.post("/api/me/notice/dismiss").status_code == 204
    assert ben.get("/api/auth/status").json()["user"]["notice"] is None

    me = c.get("/api/auth/status").json()["user"]["id"]
    assert c.delete(f"/api/users/{me}").status_code == 400
    assert c.delete(f"/api/users/{ben_id}").status_code == 204
    assert c.delete(f"/api/users/{ben_id}").status_code == 404
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM measurements WHERE user_id = ?", (ben_id,)).fetchone()[0] == 0


def test_last_admin_is_protected(c):
    me = c.get("/api/auth/status").json()["user"]["id"]
    assert c.put(f"/api/users/{me}/admin", json={"isAdmin": False}).status_code == 409
    dan = c.post("/api/users", json={"username": "dan", "password": PW}).json()
    assert c.put(f"/api/users/{dan['id']}/admin", json={"isAdmin": True}).json()["isAdmin"] is True
    # Now there are two: anna may step down, and dan may not.
    assert c.put(f"/api/users/{me}/admin", json={"isAdmin": False}).json()["isAdmin"] is False
    d = login("dan")
    assert d.put(f"/api/users/{dan['id']}/admin", json={"isAdmin": False}).status_code == 409
    assert d.request("DELETE", "/api/me", json={"password": PW}).status_code == 409
    assert d.put(f"/api/users/{me}/admin", json={"isAdmin": True}).status_code == 200
    assert d.put(f"/api/users/{me}/admin", json={"isAdmin": "yes please"}).status_code == 400
    assert c.delete(f"/api/users/{dan['id']}").status_code == 204


def test_change_password_logs_out_other_devices(c):
    c.post("/api/users", json={"username": "cleo", "password": PW})
    phone, laptop = login("cleo"), login("cleo")
    assert phone.put("/api/me/password", json={"current": "wrong", "new": "a new password"}).status_code == 400
    assert phone.put("/api/me/password", json={"current": PW, "new": "a new password"}).status_code == 429  # wait 1 s
    auth.reset_limits()
    assert phone.put("/api/me/password", json={"current": PW, "new": "a new password"}).status_code == 204
    assert phone.get("/api/profile").status_code == 200
    assert laptop.get("/api/profile").status_code == 401
    phone.post("/api/auth/logout")
    assert phone.get("/api/profile").status_code == 401


def test_export_and_delete_my_account(c):
    c.post("/api/users", json={"username": "erin", "password": PW})
    e = login("erin")
    e.put("/api/profile", json={"name": "Erin"})
    e.put("/api/days/2026-10-01/log", json={"notes": "mine"})
    e.post("/api/measurements", json={"type": "weight", "date": "2026-10-01", "value": 60})
    e.put("/api/me/paperless", json={"token": "erin-secret-token", "tags": ["health"]})
    e.post("/api/me/ingest-token")

    r = e.get("/api/me/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith('attachment; filename="health-diary-erin-')
    raw = zipfile.ZipFile(io.BytesIO(r.content)).read("data.json")
    data = json.loads(raw)
    assert data["version"] == 2 and data["user"]["username"] == "erin" and data["documents"] == []
    assert data["profile"] == {"name": "Erin"} and data["days"][0]["log"] == {"notes": "mine"}
    assert data["measurements"][0]["value"] == 60 and data["paperless"]["tags"] == ["health"]
    assert set(data["settings"]) == {"lastSync", "redactWords", "excludedDocs"}
    assert b"erin-secret-token" not in raw and b"hash" not in raw

    uid = data_uid = e.get("/api/auth/status").json()["user"]["id"]
    assert e.request("DELETE", "/api/me", json={"password": "wrong"}).status_code == 400
    auth.reset_limits()
    assert e.request("DELETE", "/api/me", json={}).status_code == 400
    r = e.request("DELETE", "/api/me", json={"password": PW})
    assert r.status_code == 204
    assert e.get("/api/profile").status_code == 401
    assert db.get_user(uid) is None
    with db.connect() as con:
        for t in ("days", "measurements", "kv", "sessions"):
            assert con.execute(f"SELECT COUNT(*) FROM {t} WHERE user_id = ?", (data_uid,)).fetchone()[0] == 0
    # The WAL file was emptied, so the deleted rows are not left in it.
    wal = db.DB_PATH.with_name("diary.db-wal")
    assert not wal.exists() or wal.stat().st_size == 0


def test_sole_user_may_delete_their_account(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "diary.db")
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "TMP_DIR", tmp_path / "tmp")
    db.init()
    uid = db.create_user("solo", auth.hash_password(PW), True)["id"]
    assert db.delete_user(uid, allow_sole_user=True) is True
    assert db.count_users() == 0


def test_passwords_are_hashed(c):
    with db.connect() as con:
        stored = con.execute("SELECT password_hash FROM users WHERE username = 'anna'").fetchone()[0]
    assert stored.startswith("scrypt$") and PW not in stored
    assert auth.verify_password(PW, stored) and not auth.verify_password(PW + "x", stored)
    assert auth.authenticate("anna", PW)["username"] == "anna"
    assert auth.authenticate("anna", "nope") is None and auth.authenticate("nobody", PW) is None


def test_migrations_set_the_version(c):
    with db.connect() as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 5
        assert con.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
        assert con.execute("PRAGMA secure_delete").fetchone()[0] == 1


def test_expired_sessions_are_purged(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    db.create_session("old", uid, "2000-01-01 00:00:00")
    with db.connect() as con:
        con.execute("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old2', ?, '2000-01-01 00:00:00')", (uid,))
    assert db.purge_sessions() >= 1
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM sessions WHERE expires_at < datetime('now')").fetchone()[0] == 0


def test_transaction_rolls_back(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    try:
        with db.transaction():
            db.save_log(uid, "2030-01-01", {"notes": "x"})
            raise RuntimeError
    except RuntimeError:
        pass
    assert db.get_day(uid, "2030-01-01")["log"] is None


# ---------- The user's own catalog

CATALOG = {
    "v": 1,
    "symptoms": [" Headache ", "Headache", "Brain fog", ""],
    "docTypes": {"custom": ["Dentist", "Blood test", "Dentist", " Eye exam "], "hidden": ["Imaging"]},
    "measurements": [
        {"id": "c_glucose", "name": "Blood glucose", "unit": "mmol/L", "low": 3.9, "high": 7.8, "min": 0.5,
         "max": 40, "step": 0.1, "hidden": False},
        {"id": "c_pain", "name": "Pain", "unit": "/10", "low": None, "high": 4, "min": 10, "max": 0, "step": None,
         "hidden": True},
        {"id": "c_glucose", "name": "Duplicate", "unit": "", "step": 1},
    ],
    "counters": [{"id": "c_tea", "name": "Tea", "one": "cup", "many": "", "hidden": False}],
}


def test_catalog_is_normalized_like_the_app(c):
    assert c.get("/api/catalog").json() is None
    r = c.put("/api/catalog", json=CATALOG)
    assert r.status_code == 200
    cat = r.json()
    assert cat["symptoms"] == ["Headache", "Brain fog"]
    assert cat["docTypes"] == {"custom": ["Dentist", "Eye exam"], "hidden": ["Imaging"]}
    assert [m["id"] for m in cat["measurements"]] == ["c_glucose", "c_pain"]
    assert cat["measurements"][1] | {} == {"id": "c_pain", "name": "Pain", "unit": "/10", "low": None, "high": 4,
                                           "min": 0, "max": 10, "step": 0.1, "hidden": True}
    assert cat["counters"] == [{"id": "c_tea", "name": "Tea", "one": "cup", "many": "times", "hidden": False}]
    assert c.get("/api/catalog").json() == cat


@pytest.mark.parametrize("bad", [
    {"measurements": [{"id": "glucose", "name": "x"}]},
    {"measurements": [{"id": "c_x1", "name": ""}]},
    {"measurements": [{"id": "c_x1", "name": "x", "step": 0}]},
    {"measurements": [{"id": "c_x1", "name": "x", "unit": "u" * 21}]},
    {"counters": [{"id": "c_" + "a" * 25, "name": "x"}]},
    {"counters": [{"id": "c_ab", "name": "x" * 41}]},
    {"docTypes": {"hidden": ["Other"]}},
    {"docTypes": {"custom": ["x" * 61]}},
    {"symptoms": ["s"] * 61},
    {"measurements": [{"id": f"c_m{i:02d}", "name": "x"} for i in range(61)]},
    {"colors": []},
])
def test_catalog_validation(c, bad):
    assert c.put("/api/catalog", json=bad).status_code == 400


def test_own_measurements(c):
    c.put("/api/catalog", json=CATALOG)
    m = c.post("/api/measurements", json={"type": "c_glucose", "date": "2026-10-02", "time": "08:00", "value": 5.4})
    assert m.status_code == 201 and m.json()["value"] == 5.4 and m.json()["type"] == "c_glucose"
    # Hidden measurements still accept values (old values stay valid).
    assert c.post("/api/measurements", json={"type": "c_pain", "date": "2026-10-02", "value": 3}).status_code == 201
    r = c.post("/api/measurements", json={"type": "c_glucose", "date": "2026-10-02", "value": 41})
    assert r.status_code == 400 and r.json()["detail"] == "Use a value from 0.5 to 40 for Blood glucose."
    r = c.post("/api/measurements", json={"type": "c_unknown", "date": "2026-10-02", "value": 1})
    assert r.status_code == 400 and "not in your list" in r.json()["detail"]
    assert c.post("/api/measurements", json={"type": "c_glucose", "date": "2026-10-02", "value": "x"}).status_code == 400
    assert [x["value"] for x in c.get("/api/measurements?type=c_glucose").json()] == [5.4]
    # Another user does not have this measurement.
    c.post("/api/users", json={"username": "gus", "password": PW})
    gus = login("gus")
    assert gus.post("/api/measurements", json={"type": "c_glucose", "date": "2026-10-02", "value": 5}).status_code == 400


def test_own_counters_in_the_day_log(c):
    log = {"drinks": {"water": 6, "coffee": None, "c_tea": 3, "c_deleted": 900}}
    assert c.put("/api/days/2026-10-03/log", json=log).status_code == 200
    assert c.get("/api/days/2026-10-03").json()["log"]["drinks"] == log["drinks"]
    for bad in ({"drinks": {"beer": 1}}, {"drinks": {"c_tea": 1000}}, {"drinks": {"water": -1}},
                {"drinks": {"C_TEA": 1}}):
        assert c.put("/api/days/2026-10-03/log", json=bad).status_code == 400, bad


def test_catalog_is_in_the_export(c):
    c.put("/api/catalog", json=CATALOG)
    data = json.loads(zipfile.ZipFile(io.BytesIO(c.get("/api/me/export").content)).read("data.json"))
    assert data["catalog"]["counters"][0]["id"] == "c_tea"


def test_migrations_run_once_in_order(tmp_path, monkeypatch):
    for name, value in (("DATA_DIR", tmp_path), ("DB_PATH", tmp_path / "diary.db"), ("TMP_DIR", tmp_path / "tmp")):
        monkeypatch.setattr(db, name, value)
    db.init()  # a new database: the base schema, version 5
    runs = []
    monkeypatch.setattr(db, "MIGRATIONS", [(6, lambda c: runs.append(6) or c.execute("ALTER TABLE users ADD COLUMN x TEXT")),
                                            (7, lambda c: runs.append(7))])
    monkeypatch.setattr(db, "SCHEMA_VERSION", 7)
    db.init()
    db.init()
    assert runs == [6, 7]
    with db.connect() as con:
        assert con.execute("PRAGMA user_version").fetchone()[0] == 7


def _db_with_version(path, version):
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE kv (key TEXT, value TEXT)")  # like a 0.1 database: no documents table
    con.execute("INSERT INTO kv VALUES ('profile', '{}')")
    con.execute(f"PRAGMA user_version = {version}")
    con.commit()
    con.close()


@pytest.mark.parametrize("version, message", [
    (4, "This data folder is from Health Diary 0.1. Version 0.2 cannot use it. Stop the app, move the data folder "
        "away, then start again with an empty folder."),
    (1, "from Health Diary 0.1"),
    (99, "This data folder is from a newer version of Health Diary. Update the app."),
])
def test_a_data_folder_of_another_version_is_refused_untouched(tmp_path, monkeypatch, capsys, version, message):
    from app import preflight
    data = tmp_path / "data"
    data.mkdir(mode=0o755)
    _db_with_version(data / "diary.db", version)
    for name, value in (("DATA_DIR", data), ("DB_PATH", data / "diary.db"), ("TMP_DIR", data / "tmp")):
        monkeypatch.setattr(db, name, value)
    before = {p.name: p.read_bytes() for p in data.iterdir()}
    with pytest.raises(db.DataFolderError, match=message[:40]):
        db.init()
    assert preflight.main() == 2
    assert message in capsys.readouterr().err
    # Nothing changed: same files, same bytes, same permissions (no tmp folder, no WAL file).
    assert {p.name: p.read_bytes() for p in data.iterdir()} == before
    assert data.stat().st_mode & 0o777 == 0o755


def test_a_current_or_new_data_folder_starts(tmp_path, monkeypatch):
    from app import preflight
    for name, value in (("DATA_DIR", tmp_path), ("DB_PATH", tmp_path / "diary.db"), ("TMP_DIR", tmp_path / "tmp")):
        monkeypatch.setattr(db, name, value)
    assert preflight.main() == 0  # no database yet
    db.init()
    assert preflight.main() == 0
    db.init()  # a second start of the same version


def test_admin_who_resets_their_own_password_stays_logged_in(c):
    me = c.get("/api/auth/status").json()["user"]["id"]
    other = login("anna")
    assert c.put(f"/api/users/{me}/password", json={"password": "another good one"}).status_code == 204
    assert c.get("/api/profile").status_code == 200  # this session stays
    assert other.get("/api/profile").status_code == 401  # other devices are logged out
    assert c.get("/api/auth/status").json()["user"]["notice"] is None
    c.put(f"/api/users/{me}/password", json={"password": PW})
