import io
import os
import sqlite3
import sys
import tempfile
import zipfile
from pathlib import Path

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["TZ"] = "Europe/Paris"
os.environ["WEB_DIR"] = str(Path(__file__).resolve().parents[2] / "web")
os.environ["COOKIE_SECURE"] = "false"
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth, db  # noqa: E402
from app import main  # noqa: E402

app = main.app
PW = "correct horse battery"


def new_client():
    return TestClient(app)


# The admin, created through the first-setup screen. Most tests use this client.
c = new_client()


def setup_module():
    assert c.get("/api/auth/status").json() == {"setupNeeded": True, "user": None}
    assert c.post("/api/auth/setup", json={"code": "WRONG", "username": "anna", "password": PW}).status_code == 403
    r = c.post("/api/auth/setup", json={"code": main.SETUP_CODE.lower(), "username": "anna", "password": PW})
    assert r.status_code == 200 and r.json()["isAdmin"] is True
    # A second setup is refused.
    assert new_client().post("/api/auth/setup", json={"code": main.SETUP_CODE, "username": "eve", "password": PW}).status_code == 409


def test_index_switches_to_server_and_sends_security_headers():
    r = new_client().get("/")
    assert r.status_code == 200 and r.text.startswith("<!doctype html>")
    assert '<script src="config.js">' in r.text
    assert "script-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-frame-options"] == "DENY"
    assert "'/api'" in new_client().get("/config.js").text
    assert new_client().get("/app.js").status_code == 200


def test_everything_needs_login():
    anon = new_client()
    for path in ["/api/profile", "/api/settings", "/api/days", "/api/days/2026-10-01", "/api/measurements",
                 "/api/documents", "/api/users", "/api/me/paperless"]:
        assert anon.get(path).status_code == 401, path
    assert anon.put("/api/profile", json={}).status_code == 401
    assert anon.post("/api/ingest/health", json={}).status_code == 401
    assert anon.get("/api/health").status_code == 200


def test_cross_site_requests_are_refused():
    r = c.put("/api/profile", json={"name": "x"}, headers={"Sec-Fetch-Site": "cross-site"})
    assert r.status_code == 403


def test_profile_and_settings():
    assert c.get("/api/profile").json() == {}
    c.put("/api/profile", json={"name": "Test", "heightCm": 180})
    assert c.get("/api/profile").json()["heightCm"] == 180
    c.put("/api/settings", json={"redactWords": ["Clinic"]})
    s = c.get("/api/settings").json()
    assert s["redactWords"] == ["Clinic"] and s["excludedDocs"] == []


def test_days():
    log = {"meals": {"breakfast": {"time": "07:30", "text": "Eggs"}}, "symptoms": []}
    assert c.put("/api/days/2026-10-01/log", json=log).status_code == 204
    assert c.get("/api/days/2026-10-01").json()["log"]["meals"]["breakfast"]["text"] == "Eggs"
    assert [d["date"] for d in c.get("/api/days?from=2026-09-30&to=2026-10-02").json()] == ["2026-10-01"]
    assert c.get("/api/days/2026-13-1").status_code == 400


def test_measurements():
    m = c.post("/api/measurements", json={"type": "temp", "date": "2026-10-02", "time": "21:00", "value": 38.2}).json()
    assert m["value"] == 38.2 and m["source"] == "manual"
    assert any(x["id"] == m["id"] for x in c.get("/api/measurements?type=temp").json())
    assert c.post("/api/measurements", json={"type": "height", "date": "2026-10-02", "value": 1}).status_code == 400
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 204
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 404


def test_documents_without_paperless():
    assert c.get("/api/documents").json() == []
    assert c.get("/api/me/paperless").json()["available"] is False


def test_users_are_isolated_and_managed_by_admin():
    # Admin adds Ben. Ben logs in on his own device.
    assert c.post("/api/users", json={"username": "ben", "password": "short"}).status_code == 400
    ben_id = c.post("/api/users", json={"username": "ben", "password": PW}).json()["id"]
    assert c.post("/api/users", json={"username": "BEN", "password": PW}).status_code == 409
    ben = new_client()
    assert ben.post("/api/auth/login", json={"username": "ben", "password": PW}).status_code == 200

    # Ben sees none of Anna's data, and Anna none of Ben's.
    assert ben.get("/api/days").json() == []
    assert ben.get("/api/profile").json() == {}
    m = ben.post("/api/measurements", json={"type": "weight", "date": "2026-10-03", "value": 70}).json()
    assert all(x["id"] != m["id"] for x in c.get("/api/measurements").json())
    assert c.delete(f"/api/measurements/{m['id']}").status_code == 404  # cannot delete another user's row

    # Ben is not an administrator.
    assert ben.get("/api/users").status_code == 403
    assert ben.post("/api/users", json={"username": "x", "password": PW}).status_code == 403

    # A new password from the admin logs Ben out.
    assert c.put(f"/api/users/{ben_id}/password", json={"password": "another good one"}).status_code == 204
    assert ben.get("/api/profile").status_code == 401

    # Deleting Ben deletes his data too.
    assert c.delete(f"/api/users/{c.get('/api/auth/status').json()['user']['id']}").status_code == 400
    assert c.delete(f"/api/users/{ben_id}").status_code == 204
    with db.connect() as con:
        assert con.execute("SELECT COUNT(*) FROM measurements WHERE user_id = ?", (ben_id,)).fetchone()[0] == 0


def test_change_password_logs_out_other_devices():
    c.post("/api/users", json={"username": "cleo", "password": PW})
    phone, laptop = new_client(), new_client()
    for x in (phone, laptop):
        assert x.post("/api/auth/login", json={"username": "cleo", "password": PW}).status_code == 200
    assert phone.put("/api/me/password", json={"current": "wrong", "new": "a new password"}).status_code == 400
    assert phone.put("/api/me/password", json={"current": PW, "new": "a new password"}).status_code == 204
    assert phone.get("/api/profile").status_code == 200
    assert laptop.get("/api/profile").status_code == 401
    phone.post("/api/auth/logout")
    assert phone.get("/api/profile").status_code == 401


def test_password_guessing_is_blocked():
    auth._failures.clear()
    x = new_client()
    for _ in range(auth.MAX_FAILURES):
        assert x.post("/api/auth/login", json={"username": "dora", "password": "nope"}).status_code == 401
    r = x.post("/api/auth/login", json={"username": "dora", "password": "nope"})
    assert r.status_code == 429 and "Retry-After" in r.headers
    auth._failures.clear()


def test_passwords_are_hashed():
    with db.connect() as con:
        stored = con.execute("SELECT password_hash FROM users WHERE username = 'anna'").fetchone()[0]
    assert stored.startswith("scrypt$") and PW not in stored
    assert auth.verify_password(PW, stored) and not auth.verify_password(PW + "x", stored)


def ingest(json, token):
    return c.post("/api/ingest/health", json=json, headers={"Authorization": f"Bearer {token}"})


@pytest.fixture(scope="module")
def key():
    return c.post("/api/me/ingest-token").json()["token"]


def test_shortcut_key(key):
    assert c.get("/api/auth/status").json()["user"]["hasIngestToken"] is True
    assert ingest({}, "wrong-key").status_code == 401
    assert c.post("/api/ingest/health", json={}, headers={"X-Diary-Token": key}).status_code == 200


SLEEP = "\n".join([
    # Watch, with stages
    "In Bed|2026-10-13T23:20:00+02:00|2026-10-14T06:40:00+02:00|Watch",
    "Core|2026-10-13T23:30:00+02:00|2026-10-14T01:00:00+02:00|Watch",
    "Deep|2026-10-14T01:00:00+02:00|2026-10-14T02:00:00+02:00|Watch",
    "Awake|2026-10-14T02:00:00+02:00|2026-10-14T02:10:00+02:00|Watch",
    "REM|2026-10-14T02:10:00+02:00|2026-10-14T03:40:00+02:00|Watch",
    "Core|2026-10-14T03:40:00+02:00|2026-10-14T06:30:00+02:00|Watch",
    # iPhone, no stages: must be ignored
    "Asleep|2026-10-13T23:00:00+02:00|2026-10-14T07:00:00+02:00|iPhone",
    # The night before: outside the window
    "Core|2026-10-12T23:00:00+02:00|2026-10-13T06:00:00+02:00|Watch",
])


def test_shortcut_ingest_keeps_hand_corrections(key):
    p = {"date": "2026-10-14", "sleep": SLEEP, "steps": "2 140", "steps_yesterday": 9832, "resting_hr": 57.6,
         "hrv": "46,7", "weight": 76.9, "weight_date": "2026-10-14T07:31:00+02:00",
         "workouts": "Walking|2026-10-14T12:10:00+02:00|2026-10-14T12:34:00+02:00"}
    h = ingest(p, key).json()["health"]
    assert h["sleep"] == {"total": 410, "deep": 60, "rem": 90, "core": 260, "awake": 10, "bed": "23:30", "wake": "06:30"}
    assert h["steps"] == 2140 and h["restingHr"] == 58 and h["hrv"] == 47
    assert h["workouts"] == [{"type": "Walking", "minutes": 24, "start": "12:10"}]
    assert c.get("/api/days/2026-10-13").json()["health"]["steps"] == 9832
    assert c.get("/api/settings").json()["lastSync"]

    # Correct the steps by hand, then sync again: the correction stays.
    c.put("/api/days/2026-10-14/health", json={**h, "steps": 5000, "edited": ["steps"]})
    h2 = ingest({**p, "steps": 3000}, key).json()["health"]
    assert h2["steps"] == 5000
    # The same weight twice is stored once.
    assert len([m for m in c.get("/api/measurements?type=weight").json() if m["date"] == "2026-10-14"]) == 1


EXPORT = """<?xml version="1.0" encoding="UTF-8"?>
<HealthData locale="fr_FR">
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2025-03-02 10:00:00 +0100" endDate="2025-03-02 10:10:00 +0100" value="4000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2025-03-02 15:00:00 +0100" endDate="2025-03-02 15:10:00 +0100" value="1000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-03-02 10:00:00 +0100" endDate="2025-03-02 10:10:00 +0100" value="4200"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2025-03-02 08:00:00 +0100" endDate="2025-03-02 20:00:00 +0100" value="61"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="lb" startDate="2025-03-02 07:00:00 +0100" endDate="2025-03-02 07:00:00 +0100" value="170"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2025-03-01 23:00:00 +0100" endDate="2025-03-02 03:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2025-03-02 03:00:00 +0100" endDate="2025-03-02 04:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100" value="128"/>
  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" sourceName="Cuff" unit="mmHg" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100" value="82"/>
 </Correlation>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" startDate="2025-03-02 18:00:00 +0100" endDate="2025-03-02 18:45:00 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="200" unit="kcal"/>
 </Workout>
</HealthData>"""


def _zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("apple_health_export/exportation.xml", EXPORT)
        z.writestr("apple_health_export/export_cda.xml", "<x/>" * 5000)
    return buf.getvalue()


def test_import_export_zip():
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", _zip(), "application/zip")}).json()
    assert r["days"] == 1 and r["first"] == "2025-03-02"
    assert r["measurements"] == {"weight": 1, "bp": 1}
    h = c.get("/api/days/2025-03-02").json()["health"]
    assert h["steps"] == 5000  # iPhone 5000 beats Watch 4200; they are not added together
    assert h["restingHr"] == 61
    assert h["sleep"]["total"] == 300 and h["sleep"]["deep"] == 60
    assert h["workouts"][0] == {"type": "Traditional Strength Training", "minutes": 45, "start": "18:00"}
    w = [m for m in c.get("/api/measurements?type=weight").json() if m["date"] == "2025-03-02"][0]
    assert w["value"] == 77.1
    # A second import adds nothing.
    assert c.post("/api/import/apple-health", files={"file": ("export.zip", _zip(), "application/zip")}).json()["measurements"] == {}


def test_import_rejects_garbage():
    assert c.post("/api/import/apple-health", files={"file": ("x.zip", b"not a zip", "application/zip")}).status_code == 400


def test_steps_by_day(key):
    lines = "8 412|2026-10-19T00:00:00+02:00|2026-10-20T00:00:00+02:00\n1520|2026-10-20T00:00:00+02:00|2026-10-21T00:00:00+02:00"
    h = ingest({"date": "2026-10-20", "steps_days": lines}, key).json()["health"]
    assert h["steps"] == 1520
    assert c.get("/api/days/2026-10-19").json()["health"]["steps"] == 8412


def test_version_1_database_moves_to_the_first_account(tmp_path, monkeypatch):
    """A database from before accounts existed: the first account gets its data."""
    monkeypatch.setattr(db, "DATA_DIR", tmp_path)
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "diary.db")
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
    uid = db.create_user("first", auth.hash_password(PW), is_admin=True)["id"]
    assert db.get_kv(uid, "profile", {}) == {"name": "Old"}
    assert db.get_day(uid, "2025-01-01")["log"] == {"notes": "old entry"}
    assert db.list_measurements(uid)[0]["value"] == 80
    second = db.create_user("second", auth.hash_password(PW))["id"]
    assert db.list_days(second) == []
