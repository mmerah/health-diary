import json
import sqlite3

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


def test_old_profile_is_returned_as_is(c):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    db.set_kv(uid, "profile", {"medications": "Aspirin\nVitamin D"})
    assert c.get("/api/profile").json() == {"medications": "Aspirin\nVitamin D"}


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
        {"drinks": {"water": 51}},
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
    assert c.get("/api/documents").json() == []
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
    e.put("/api/me/paperless", json={"token": "erin-secret-token", "tag": "health"})
    e.post("/api/me/ingest-token")

    r = e.get("/api/me/export")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith('attachment; filename="health-diary-erin-')
    data = r.json()
    assert data["version"] == 1 and data["user"]["username"] == "erin"
    assert data["profile"] == {"name": "Erin"} and data["days"][0]["log"] == {"notes": "mine"}
    assert data["measurements"][0]["value"] == 60 and data["paperless"] == {"tag": "health"}
    assert set(data["settings"]) == {"lastSync", "redactWords", "excludedDocs"}
    assert "erin-secret-token" not in r.text and "hash" not in r.text

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
        assert con.execute("PRAGMA user_version").fetchone()[0] == db.SCHEMA_VERSION == 4
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


def test_version_1_database_moves_to_the_first_account(tmp_path, monkeypatch):
    """A database from before accounts existed: the first account gets its data."""
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "diary.db")
    monkeypatch.setattr(db, "TMP_DIR", tmp_path / "tmp")
    old = sqlite3.connect(tmp_path / "diary.db")
    old.executescript("""
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE days (date TEXT PRIMARY KEY, log TEXT, health TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')));
      CREATE TABLE measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, date TEXT NOT NULL, time TEXT,
        value TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', external_id TEXT UNIQUE,
        created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO kv VALUES ('profile', '{"name": "Old"}');
      INSERT INTO days (date, log) VALUES ('2025-01-01', '{"notes": "old entry"}');
      INSERT INTO measurements (type, date, value) VALUES ('weight', '2025-01-01', '80');
    """)
    old.commit()
    old.close()
    db.init()
    uid = db.create_user("first", auth.hash_password(PW), is_admin=True, only_if_empty=True)["id"]
    assert db.get_kv(uid, "profile", {}) == {"name": "Old"}
    assert db.get_day(uid, "2025-01-01")["log"] == {"notes": "old entry"}
    assert db.list_measurements(uid)[0]["value"] == 80
    second = db.create_user("second", auth.hash_password(PW))["id"]
    assert db.list_days(second) == []
    assert json.loads(json.dumps(db.get_user(uid)))["ingestLastUsed"] is None


def test_version_3_database_gets_versions(tmp_path, monkeypatch):
    """Logs and profiles saved before versions existed start at version 1."""
    for name, value in (("DATA_DIR", tmp_path), ("DB_PATH", tmp_path / "diary.db"), ("TMP_DIR", tmp_path / "tmp")):
        monkeypatch.setattr(db, name, value)
    monkeypatch.setattr(db, "MIGRATIONS", db.MIGRATIONS[:2])
    db.init()
    uid = db.create_user("old", auth.hash_password(PW), True)["id"]
    with db.connect() as con:
        con.execute("INSERT INTO days (user_id, date, log) VALUES (?, '2025-01-01', '{}')", (uid,))
        con.execute("INSERT INTO days (user_id, date, health) VALUES (?, '2025-01-02', '{}')", (uid,))
        con.execute("""INSERT INTO kv (user_id, key, value) VALUES (?, 'profile', '{"name": "Old"}')""", (uid,))
    monkeypatch.undo()
    for name, value in (("DATA_DIR", tmp_path), ("DB_PATH", tmp_path / "diary.db"), ("TMP_DIR", tmp_path / "tmp")):
        monkeypatch.setattr(db, name, value)
    db.init()
    assert [d["logVersion"] for d in db.list_days(uid)] == [1, 0]
    assert db.get_kv_version(uid, "profile", {}) == ({"name": "Old"}, 1)
