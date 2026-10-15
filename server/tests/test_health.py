import io
import tracemalloc
import zipfile
from datetime import date

import pytest
from conftest import new_client

from app import db, health
from app.health import Sample, _num, parse_dt, parse_weight, summarize_sleep


@pytest.fixture(scope="module")
def key(c):
    return c.post("/api/me/ingest-token").json()["token"]


def ingest(c, json, token):
    return c.post("/api/ingest/health", json=json, headers={"Authorization": f"Bearer {token}"})


# ---------- Numbers and units

@pytest.mark.parametrize("raw, integer, expected", [
    ("12,345", True, 12345), ("1,234", False, 1234), ("46,7", False, 46.7), ("2 140", True, 2140),
    ("2 140", True, 2140), ("2 140", True, 2140), ("2'140", True, 2140), ("1,234.5", False, 1234.5),
    ("1.234,5", False, 1234.5), ("12.345", True, 12345), ("57.6", False, 57.6), ("76.9 kg", False, 76.9),
    (2140, True, 2140), ("", False, None), ("abc", False, None), (None, False, None), (True, False, None),
    ("0,5", False, 0.5),
])
def test_num(raw, integer, expected):
    assert _num(raw, integer) == expected


@pytest.mark.parametrize("raw, unit, expected", [
    ("76.9", None, 76.9), ("76,9 kg", None, 76.9), ("170 lb", None, 77.1), ("170 lbs", None, 77.1),
    ("12 st", None, 76.2), ("12 st 4 lb", None, 78.0), (170, "lb", 77.1), ("170", "lbs", 77.1),
    (12, "st", 76.2), ("3000", None, None), ("76 furlongs", None, None),
])
def test_weight_units(raw, unit, expected):
    assert parse_weight(raw, unit) == expected


@pytest.mark.parametrize("raw, field, integer, expected", [
    ("45,123", "hrv", False, 45.123),       # 45123 cannot be an HRV: decimal comma
    ("62,333", "restingHr", False, 62.333),
    ("12,345", "steps", True, 12345),       # 12.345 steps is possible but 12345 is the reading
    ("1,234", "hrv", False, 1.234),
    ("9 999 999", "steps", True, None),
])
def test_read_uses_the_plausible_reading(raw, field, integer, expected):
    assert health.read(raw, field, integer) == expected
    assert parse_weight("76,500") == 76.5


# ---------- Sleep

def s(stage, start, end, src="Watch"):
    return Sample(stage, parse_dt(start), parse_dt(end), src)


SLEEP = "\n".join([
    # Watch, with stages
    "In Bed|2026-10-13T23:20:00+02:00|2026-10-14T06:40:00+02:00|Watch",
    "Core|2026-10-13T23:30:00+02:00|2026-10-14T01:00:00+02:00|Watch",
    "Deep|2026-10-14T01:00:00+02:00|2026-10-14T02:00:00+02:00|Watch",
    "Awake|2026-10-14T02:00:00+02:00|2026-10-14T02:10:00+02:00|Watch",
    "REM|2026-10-14T02:10:00+02:00|2026-10-14T03:40:00+02:00|Watch",
    "Core|2026-10-14T03:40:00+02:00|2026-10-14T06:30:00+02:00|Watch",
    # iPhone, one block for the whole bedtime: not used, the Watch has stages
    "Asleep|2026-10-13T23:00:00+02:00|2026-10-14T07:00:00+02:00|iPhone",
    # The night before: another day
    "Core|2026-10-12T23:00:00+02:00|2026-10-13T06:00:00+02:00|Watch",
])


def test_sleep_overlaps_count_once():
    night = [s("core", "2026-10-13T23:00+02:00", "2026-10-14T03:00+02:00"),
             s("core", "2026-10-14T02:00+02:00", "2026-10-14T05:00+02:00"),  # overlaps the first
             s("asleep", "2026-10-13T23:00+02:00", "2026-10-14T05:00+02:00")]  # generic, under the stages
    r = summarize_sleep(night)
    assert r["total"] == 360 and r["core"] == 360 and r["deep"] == 0


def test_watch_with_stages_beats_a_longer_iphone_block():
    # Watch: 6 h 40 asleep, with awake gaps. iPhone: one 7 h 30 "Asleep" block (89% is above 70%).
    night = [s("core", "2026-10-13T23:20+02:00", "2026-10-14T01:00+02:00", "Watch"),
             s("awake", "2026-10-14T01:00+02:00", "2026-10-14T01:20+02:00", "Watch"),
             s("deep", "2026-10-14T01:20+02:00", "2026-10-14T02:20+02:00", "Watch"),
             s("awake", "2026-10-14T02:20+02:00", "2026-10-14T02:50+02:00", "Watch"),
             s("rem", "2026-10-14T02:50+02:00", "2026-10-14T06:50+02:00", "Watch"),
             s("asleep", "2026-10-13T23:20+02:00", "2026-10-14T06:50+02:00", "iPhone")]
    r = summarize_sleep(night)
    assert (r["total"], r["core"], r["deep"], r["rem"], r["awake"]) == (400, 100, 60, 240, 50)


def test_iphone_wins_when_the_watch_saw_little_of_the_night():
    # The Watch was taken off to charge after 1 hour. The iPhone saw the whole night.
    night = [s("core", "2026-10-13T23:00+02:00", "2026-10-14T00:00+02:00", "Watch"),
             s("asleep", "2026-10-13T23:00+02:00", "2026-10-14T07:00+02:00", "iPhone")]
    r = summarize_sleep(night)
    assert r["total"] == 480 and r["deep"] is None and r["wake"] == "07:00"


def test_sleep_sessions_and_naps():
    night = [s("core", "2026-10-13T23:00+02:00", "2026-10-14T03:00+02:00"),
             s("core", "2026-10-14T03:30+02:00", "2026-10-14T07:00+02:00"),  # gap of 30 min: same sleep
             s("core", "2026-10-14T14:00+02:00", "2026-10-14T14:40+02:00"),  # a nap
             s("awake", "2026-10-14T03:00+02:00", "2026-10-14T03:30+02:00")]
    r = summarize_sleep(night)
    assert (r["bed"], r["wake"], r["total"], r["awake"]) == ("23:00", "07:00", 450, 30)
    assert r["naps"] == [{"start": "14:00", "end": "14:40", "minutes": 40}] and r["inBedOnly"] is False


def test_long_awake_time_at_night_is_not_a_nap():
    night = [s("core", "2026-10-13T23:00+02:00", "2026-10-14T02:00+02:00"),
             s("core", "2026-10-14T04:30+02:00", "2026-10-14T07:00+02:00")]
    r = summarize_sleep(night)
    assert (r["total"], r["bed"], r["wake"], r["naps"]) == (330, "23:00", "07:00", [])
    # Same with the awake time recorded, and outside the night window (a late sleeper).
    late = [s("core", "2026-10-14T03:00+02:00", "2026-10-14T06:00+02:00"),
            s("awake", "2026-10-14T06:00+02:00", "2026-10-14T09:00+02:00"),
            s("core", "2026-10-14T09:00+02:00", "2026-10-14T12:00+02:00")]
    r = summarize_sleep(late)
    assert (r["total"], r["awake"], r["wake"], r["naps"]) == (360, 180, "12:00", [])


def test_a_real_nap_stays_a_nap():
    night = [s("core", "2026-10-13T23:00+02:00", "2026-10-14T07:00+02:00"),
             s("core", "2026-10-14T14:00+02:00", "2026-10-14T14:40+02:00")]
    r = summarize_sleep(night)
    assert r["total"] == 480 and r["naps"] == [{"start": "14:00", "end": "14:40", "minutes": 40}]


def test_in_bed_only_falls_back_to_time_in_bed():
    r = summarize_sleep([s("inbed", "2026-10-13T23:15+02:00", "2026-10-14T06:45+02:00", "iPhone")])
    assert r["total"] == 450 and r["inBedOnly"] is True and r["deep"] is None


def test_sleep_over_a_dst_change():
    # 25 Oct 2026, Paris: 03:00 CEST becomes 02:00 CET. 23:00 to 07:00 is 9 hours.
    night = [s("core", "2026-10-24T23:00:00", "2026-10-25T07:00:00")]  # no offset: $TZ (Europe/Paris)
    assert summarize_sleep(night)["total"] == 540


def test_sleep_after_travel_shows_local_times():
    # Went to bed in New York (UTC-4).
    night = [s("core", "2026-10-13T23:00-04:00", "2026-10-14T07:00-04:00")]
    r = summarize_sleep(night)
    assert (r["bed"], r["wake"]) == ("23:00", "07:00")
    assert health.night_of(night[0].end) == date(2026, 10, 14)


def test_night_of():
    assert health.night_of(parse_dt("2026-10-14T18:00:00+02:00")) == date(2026, 10, 14)
    assert health.night_of(parse_dt("2026-10-14T18:30:00+02:00")) == date(2026, 10, 15)


# ---------- Shortcut

def test_shortcut_ingest_keeps_hand_corrections(c, key):
    p = {"date": "2026-10-14", "sleep": SLEEP, "steps": "2 140", "steps_yesterday": 9832, "resting_hr": 57.6,
         "hrv": "46,7", "weight": 76.9, "weight_date": "2026-10-14T07:31:00+02:00",
         "workouts": "Walking|2026-10-14T12:10:00+02:00|2026-10-14T12:34:00+02:00"}
    h = ingest(c, p, key).json()["health"]
    assert h["sleep"] == {"total": 410, "deep": 60, "rem": 90, "core": 260, "awake": 10, "bed": "23:30",
                          "wake": "06:30", "naps": [], "inBedOnly": False}
    assert h["steps"] == 2140 and h["restingHr"] == 58 and h["hrv"] == 47
    assert h["workouts"] == [{"type": "Walking", "minutes": 24, "start": "12:10"}]
    assert c.get("/api/days/2026-10-13").json()["health"]["steps"] == 9832
    assert c.get("/api/settings").json()["lastSync"]
    assert c.get("/api/auth/status").json()["user"]["ingestLastUsed"].endswith("Z")

    # Correct the steps by hand, then sync again: the correction stays.
    assert c.put("/api/days/2026-10-14/health", json={**h, "steps": 5000, "edited": ["steps"]}).status_code == 204
    h2 = ingest(c, {**p, "steps": 3000}, key).json()["health"]
    assert h2["steps"] == 5000
    # The same weight twice is stored once.
    assert len([m for m in c.get("/api/measurements?type=weight").json() if m["date"] == "2026-10-14"]) == 1


def test_shortcut_refuses_unknown_fields_and_bad_values(c, key):
    assert ingest(c, {"stepz": 1}, key).status_code == 400
    assert ingest(c, {"date": "14/10/2026"}, key).status_code == 400
    # Values that cannot be true are ignored.
    h = ingest(c, {"date": "2026-10-16", "steps": "9999999", "resting_hr": 5, "hrv": "abc"}, key).json()["health"]
    assert "steps" not in h and "restingHr" not in h and "hrv" not in h


def test_weight_in_pounds_without_time(c, key):
    for _ in range(2):
        assert ingest(c, {"date": "2026-10-15", "weight": "170 lb"}, key).status_code == 200
    ws = [m for m in c.get("/api/measurements?type=weight&from=2026-10-15&to=2026-10-15").json()]
    assert [(m["value"], m["time"], m["source"]) for m in ws] == [(77.1, None, "apple")]
    assert ingest(c, {"date": "2026-10-17", "weight": 12, "weight_unit": "st"}, key).status_code == 200
    assert c.get("/api/measurements?type=weight&from=2026-10-17").json()[0]["value"] == 76.2


def test_steps_by_day(c, key):
    lines = "8 412|2026-10-19T00:00:00+02:00|2026-10-20T00:00:00+02:00\n1520|2026-10-20T00:00:00+02:00|2026-10-21T00:00:00+02:00"
    h = ingest(c, {"date": "2026-10-20", "steps_days": lines}, key).json()["health"]
    assert h["steps"] == 1520
    assert c.get("/api/days/2026-10-19").json()["health"]["steps"] == 8412


def test_resting_hr_and_hrv_by_day(c, key):
    p = {"date": "2026-10-22",
         "resting_hr_days": "55|2026-10-21T00:00:00+02:00|2026-10-22T00:00:00+02:00\n"
                            "58|2026-10-22T00:00:00+02:00|2026-10-23T00:00:00+02:00",
         "hrv_days": ["40|2026-10-21T03:00:00+02:00|2026-10-21T03:01:00+02:00",
                      "50|2026-10-21T05:00:00+02:00|2026-10-21T05:01:00+02:00",
                      "61,2|2026-10-22T04:00:00+02:00|2026-10-22T04:01:00+02:00"]}
    h = ingest(c, p, key).json()["health"]
    assert (h["restingHr"], h["hrv"]) == (58, 61)
    y = c.get("/api/days/2026-10-21").json()["health"]
    assert (y["restingHr"], y["hrv"]) == (55, 45)


# ---------- Full export

EXPORT = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE HealthData [
<!ELEMENT HealthData (ExportDate,Me,(Record|Correlation|Workout)*)>
<!ATTLIST HealthData locale CDATA #REQUIRED>
]>
<HealthData locale="fr_FR">
 <ExportDate value="2025-03-05 10:00:00 +0100"/>
 <Me HKCharacteristicTypeIdentifierBiologicalSex="HKBiologicalSexNotSet"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2025-03-02 10:00:00 +0100" endDate="2025-03-02 10:10:00 +0100" value="4000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="iPhone" unit="count" startDate="2025-03-02 15:00:00 +0100" endDate="2025-03-02 15:10:00 +0100" value="1000"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-03-02 10:00:00 +0100" endDate="2025-03-02 10:10:00 +0100" value="4200"/>
 <Record type="HKQuantityTypeIdentifierStepCount" sourceName="Watch" unit="count" startDate="2025-03-02 18:00:00 +0100" endDate="2025-03-02 18:45:00 +0100" value="3000"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2025-03-02 08:00:00 +0100" endDate="2025-03-02 20:00:00 +0100" value="61"/>
 <Record type="HKQuantityTypeIdentifierRestingHeartRate" sourceName="Watch" unit="count/min" startDate="2025-03-02 08:00:00 +0100" endDate="2025-03-02 20:00:00 +0100" value="900"/>
 <Record type="HKQuantityTypeIdentifierBodyMass" sourceName="Scale" unit="lb" startDate="2025-03-02 07:00:00 +0100" endDate="2025-03-02 07:00:00 +0100" value="170"/>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2025-03-01 23:00:00 +0100" endDate="2025-03-02 03:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepCore">
  <MetadataEntry key="HKTimeZone" value="Europe/Paris"/>
 </Record>
 <Record type="HKCategoryTypeIdentifierSleepAnalysis" sourceName="Watch" startDate="2025-03-02 03:00:00 +0100" endDate="2025-03-02 04:00:00 +0100" value="HKCategoryValueSleepAnalysisAsleepDeep"/>
 <Correlation type="HKCorrelationTypeIdentifierBloodPressure" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100">
  <Record type="HKQuantityTypeIdentifierBloodPressureSystolic" sourceName="Cuff" unit="mmHg" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100" value="128"/>
  <Record type="HKQuantityTypeIdentifierBloodPressureDiastolic" sourceName="Cuff" unit="mmHg" startDate="2025-03-02 19:00:00 +0100" endDate="2025-03-02 19:00:00 +0100" value="82"/>
 </Correlation>
 <Workout workoutActivityType="HKWorkoutActivityTypeTraditionalStrengthTraining" duration="45" durationUnit="min" startDate="2025-03-02 18:00:00 +0100" endDate="2025-03-02 18:45:00 +0100">
  <WorkoutStatistics type="HKQuantityTypeIdentifierActiveEnergyBurned" sum="200" unit="kcal"/>
 </Workout>
 <ActivitySummary dateComponents="2025-03-02" activeEnergyBurned="300"/>
</HealthData>"""


def _zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("apple_health_export/exportation.xml", EXPORT)
        z.writestr("apple_health_export/export_cda.xml", "<x/>" * 5000)
    return buf.getvalue()


def test_import_export_zip(c):
    r = c.post("/api/import/apple-health", files={"file": ("export.zip", _zip(), "application/zip")}).json()
    assert r == {"days": 1, "measurements": {"weight": 1, "bp": 1}, "skipped": 0, "first": "2025-03-02", "last": "2025-03-02"}
    h = c.get("/api/days/2025-03-02").json()["health"]
    # Per hour, the device with the most steps; then the hours add up: 4200 + 1000 + 3000.
    assert h["steps"] == 8200
    assert h["restingHr"] == 61  # 900 is not a heart rate
    assert h["sleep"]["total"] == 300 and h["sleep"]["deep"] == 60 and h["sleep"]["naps"] == []
    assert h["workouts"][0] == {"type": "Traditional Strength Training", "minutes": 45, "start": "18:00"}
    w = [m for m in c.get("/api/measurements?type=weight").json() if m["date"] == "2025-03-02"][0]
    assert w["value"] == 77.1
    # A second import adds nothing.
    assert c.post("/api/import/apple-health", files={"file": ("export.zip", _zip(), "application/zip")}).json()["measurements"] == {}
    assert list(db.TMP_DIR.iterdir()) == []


def test_import_fills_only_empty_fields(c):
    c.put("/api/days/2025-03-03/health", json={"steps": 123, "edited": ["steps"]})
    xml = EXPORT.replace("2025-03-02", "2025-03-03").encode()
    r = c.post("/api/import/apple-health", files={"file": ("export.xml", xml, "text/xml")})
    assert r.status_code == 200
    assert c.get("/api/days/2025-03-03").json()["health"]["steps"] == 123


def test_import_is_all_or_nothing(c, monkeypatch):
    def broken(*a, **k):
        raise RuntimeError("disk full")
    monkeypatch.setattr(db, "add_measurements", broken)
    xml = EXPORT.replace("2025-03-02", "2025-04-02").encode()
    x = new_client(cookies=c.cookies, raise_server_exceptions=False)
    assert x.post("/api/import/apple-health", files={"file": ("export.xml", xml, "text/xml")}).status_code == 500
    assert c.get("/api/days/2025-04-02").json()["health"] is None


def test_import_memory_is_freed(tmp_path):
    """Each top-level element is cleared after use: the tree does not keep the records."""
    seen = []
    real = health.iterparse

    def spy(*a, **k):
        for event, el in real(*a, **k):
            if event == "end" and el.tag == "HealthData":
                seen.append(len(el))
            yield event, el
    p = tmp_path / "export.xml"
    p.write_text(EXPORT)
    health.iterparse, orig = spy, health.iterparse
    try:
        days, _, _ = health._read_export(open(p, "rb"))
    finally:
        health.iterparse = orig
    assert seen == [0] and days


def test_broken_records_are_skipped(c):
    xml = EXPORT.replace("2025-03-02", "2025-05-02").replace(
        "<ActivitySummary", '<Record type="HKQuantityTypeIdentifierStepCount" value="10"/>'
        '<Record type="HKQuantityTypeIdentifierRestingHeartRate" startDate="yesterday" endDate="x" value="60"/>'
        '<Workout workoutActivityType="Run"/><ActivitySummary').encode()
    r = c.post("/api/import/apple-health", files={"file": ("export.xml", xml, "text/xml")})
    assert r.status_code == 200 and r.json()["skipped"] == 3 and r.json()["days"] == 1
    assert c.get("/api/days/2025-05-02").json()["health"]["steps"] == 8200


def test_junk_inside_a_record_does_not_use_memory(tmp_path):
    """A hostile file can put millions of elements inside one record. Each one is freed when it ends."""
    p = tmp_path / "export.xml"
    junk = b"<a/>" * 300_000  # 1.2 MB of text, about 50 MB as kept elements
    p.write_bytes(b'<HealthData><Record type="HKQuantityTypeIdentifierStepCount" sourceName="x" '
                  b'startDate="2025-01-01 10:00:00 +0100" endDate="2025-01-01 10:05:00 +0100" value="5">'
                  + junk + b"</Record></HealthData>")
    tracemalloc.start()
    try:
        with open(p, "rb") as fh:
            days, _, _ = health._read_export(fh)
        peak = tracemalloc.get_traced_memory()[1]
    finally:
        tracemalloc.stop()
    assert days[date(2025, 1, 1)]["steps"] == 5
    assert peak < 5 * 1024 * 1024, peak


def test_deep_nesting_is_refused(tmp_path):
    p = tmp_path / "export.xml"
    p.write_bytes(b"<HealthData>" + b"<a>" * 1000 + b"</a>" * 1000 + b"</HealthData>")
    with pytest.raises(health.ImportRefused), open(p, "rb") as fh:
        health._read_export(fh)
