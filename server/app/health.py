"""Apple Health data: the payload of the iPhone shortcut, and the full export.zip.

Both paths end in the same per-day "health" object that the front end shows:
  { sleep: {total, deep, rem, core, awake, bed, wake, naps: [{start, end, minutes}], inBedOnly},
    steps, restingHr, hrv, workouts: [{type, minutes, start}], source: 'apple', syncedAt, edited: [...] }
Fields listed in "edited" were corrected by hand. A sync or an import never overwrites them.

Times keep the UTC offset that came with each sample: after a flight, bed and wake times
are shown in the local time of the place where you slept.
"""
import logging
import math
import os
import re
import zipfile
from collections import defaultdict
from contextlib import ExitStack
from datetime import date as Date
from datetime import datetime, timedelta
from typing import NamedTuple
from zoneinfo import ZoneInfo

from defusedxml.ElementTree import iterparse

from . import db

log = logging.getLogger("uvicorn.error")
TZ = ZoneInfo(os.environ.get("TZ") or "UTC")
MAX_UNPACKED = int(os.environ.get("MAX_IMPORT_UNPACKED_MB", "4096")) * 1024 * 1024
MAX_RATIO = 200  # Apple's export.xml packs about 10 to 20 times; far more means a zip bomb

# Values outside these ranges are typing or unit mistakes. They are ignored.
RANGES = {"steps": (0, 200_000), "restingHr": (20, 250), "hrv": (1, 400), "weight": (20, 300),
          "temp": (34, 43), "sys": (60, 260), "dia": (30, 160)}
LB, STONE = 0.45359237, 6.35029318


class ImportRefused(ValueError):
    """The message is plain text for the user."""


def plausible(field, v):
    lo, hi = RANGES[field]
    return v if v is not None and lo <= v <= hi else None


def parse_dt(s):
    """Parses ISO 8601 (from Shortcuts) and '2026-10-14 07:30:00 +0200' (from export.xml).
    Keeps the offset of the text. A time without offset is in $TZ."""
    s = s.strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$", s)
    if m:
        s = f"{m[1]}T{m[2]}{m[3]}:{m[4]}"
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    return dt if dt.tzinfo else dt.replace(tzinfo=TZ)


def minutes(start, end):
    # Timestamps, not wall-clock times: a night with a DST change has 1 hour more or less.
    return (end.timestamp() - start.timestamp()) / 60


def hhmm(dt):
    return dt.strftime("%H:%M")


# ---------- Numbers

_NUM = re.compile(r"-?\d[\d\s  '’.,]*")
_GROUP_SEP = "[\\s  '’]"


def _num(x, integer=False):
    """Reads numbers as Shortcuts may send them: 2140, "2 140", "2'140", "12,345" (thousands),
    "46,7" (decimal comma), "76.9 kg". integer=True also reads "12.345" as thousands."""
    if x is None or isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return float(x) if math.isfinite(x) else None
    m = _NUM.search(str(x))
    if not m:
        return None
    t = m[0].rstrip("   '’.,")
    sign = -1 if t.startswith("-") else 1
    t = t.lstrip("-")
    if re.fullmatch(rf"\d{{1,3}}({_GROUP_SEP}\d{{3}})+([.,]\d+)?", t):
        t = re.sub(_GROUP_SEP, "", t)
    t = re.split(_GROUP_SEP, t)[0]  # "76 2" is two numbers: take the first
    if "," in t and "." in t:  # the last mark is the decimal mark
        t = t.replace(".", "").replace(",", ".") if t.rfind(",") > t.rfind(".") else t.replace(",", "")
    elif re.fullmatch(r"[1-9]\d{0,2}(,\d{3})+", t):
        t = t.replace(",", "")
    elif integer and re.fullmatch(r"[1-9]\d{0,2}(\.\d{3})+", t):
        t = t.replace(".", "")
    else:
        t = t.replace(",", ".")
    try:
        return sign * float(t)
    except ValueError:
        return None


_UNITS = {"kg": 1, "kgs": 1, "kilo": 1, "kilos": 1, "kilogram": 1, "kilograms": 1,
          "lb": LB, "lbs": LB, "pound": LB, "pounds": LB, "livre": LB, "livres": LB,
          "st": STONE, "stone": STONE, "stones": STONE}


def parse_weight(raw, unit=None):
    """Returns kg, or None. Reads "76.9", "76,9 kg", "170 lb", "170 lbs", "12 st", "12 st 4 lb".
    `unit` (kg, lb, st) applies when the text has no unit."""
    text = str(raw if raw is not None else "").strip().lower()
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)\s*(?:st|stones?)\s*(?:(\d+(?:[.,]\d+)?)\s*(?:lbs?|pounds?)?)?", text)
    if m:
        kg = float(m[1].replace(",", ".")) * STONE + float((m[2] or "0").replace(",", ".")) * LB
    else:
        v = _num(raw)
        if v is None:
            return None
        found = re.search(r"\d\s*([a-z]+)", text)
        name = found[1] if found else (str(unit or "kg").strip().lower())
        if name not in _UNITS:
            log.info("Weight with an unknown unit ignored: %r", name[:20])
            return None
        kg = v * _UNITS[name]
    return plausible("weight", round(kg, 1))


# ---------- Sleep

ASLEEP = ("core", "deep", "rem", "asleep")
STAGES = ("core", "deep", "rem")
STAGED_SHARE = 0.7  # see summarize_sleep
SESSION_GAP = 90  # minutes. A longer gap starts a new sleep session (a nap, or a second sleep).


class Sample(NamedTuple):
    stage: str | None
    start: datetime
    end: datetime
    source: str


def sleep_stage(value):
    """Maps a sleep value to a stage. Accepts HealthKit names and the English and French Shortcuts labels."""
    v = (value or "").lower().replace("hkcategoryvaluesleepanalysis", "")
    if "rem" in v or "paradox" in v:
        return "rem"
    if "deep" in v or "profond" in v:
        return "deep"
    if "core" in v or "principal" in v or "léger" in v or "leger" in v or "light" in v:
        return "core"
    if "awake" in v or "éveil" in v or "eveil" in v:
        return "awake"
    if "inbed" in v or "in bed" in v or "au lit" in v:
        return "inbed"
    if "asleep" in v or "endormi" in v or "unspecified" in v or "sleep" in v or "sommeil" in v:
        return "asleep"
    return None


def night_of(end):
    """The day a sleep sample belongs to: it ends between 18:00 the day before and 18:00 that day,
    in the local time of the sample."""
    return end.date() + timedelta(days=1) if (end.hour, end.minute, end.second) > (18, 0, 0) else end.date()


# Intervals are (start_ts, end_ts, start_dt, end_dt): timestamps to compute, datetimes to show.

def _intervals(samples, stages):
    return _union([(s.start.timestamp(), s.end.timestamp(), s.start, s.end)
                   for s in samples if s.stage in stages and s.end > s.start])


def _union(iv):
    out = []
    for s, e, sd, ed in sorted(iv, key=lambda x: x[0]):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1] = (out[-1][0], e, out[-1][2], ed)
        else:
            out.append((s, e, sd, ed))
    return out


def _length(iv):
    return sum(e - s for s, e, _, _ in iv) / 60


def _clip(iv, lo, hi):
    return [(max(s, lo), min(e, hi), sd, ed) for s, e, sd, ed in iv if e > lo and s < hi]


def _sessions(iv):
    out = []
    for x in iv:
        if out and (x[0] - out[-1][-1][1]) / 60 <= SESSION_GAP:
            out[-1].append(x)
        else:
            out.append([x])
    return out


def summarize_sleep(samples):
    """samples: the Sample list of one night (see night_of). Returns the sleep object or None."""
    by_src = defaultdict(list)
    for s in samples:
        if s.stage:
            by_src[s.source or ""].append(s)
    if not by_src:
        return None
    # iPhone and Watch both record sleep (overlaps counted once). The iPhone often writes one block
    # for the whole bedtime; the Watch leaves out the awake times and has stages. So prefer a source
    # with stages if it has at least 70% of the best time asleep (the Watch was worn); else take the
    # source with the most time asleep (the Watch was charging). With no asleep data, use time in bed.
    def coverage(it):
        return _length(_intervals(it, ASLEEP)), _length(_intervals(it, ("inbed",)))

    best = max(by_src.values(), key=coverage)
    staged = [it for it in by_src.values() if _intervals(it, STAGES)]
    top_staged = max(staged, key=coverage, default=None)
    use_staged = top_staged is not None and coverage(top_staged)[0] >= STAGED_SHARE * coverage(best)[0]
    items = top_staged if use_staged else best
    base = _intervals(items, ASLEEP)
    in_bed_only = not base
    if in_bed_only:
        base = _intervals(items, ("inbed",))
    if not base:
        return None
    sessions = _sessions(base)
    main = max(sessions, key=_length)
    lo, hi = main[0][0], main[-1][1]
    has_stages = bool(_clip(_intervals(items, STAGES), lo, hi))

    def stage(name):
        return round(_length(_clip(_intervals(items, (name,)), lo, hi))) if has_stages else None

    return {
        "total": round(_length(main)),
        "deep": stage("deep"),
        "rem": stage("rem"),
        "core": stage("core"),
        "awake": round(_length(_clip(_intervals(items, ("awake",)), lo, hi))),
        "bed": hhmm(main[0][2]),
        "wake": hhmm(main[-1][3]),
        "naps": [{"start": hhmm(s[0][2]), "end": hhmm(s[-1][3]), "minutes": round(_length(s))}
                 for s in sessions if s is not main],
        "inBedOnly": in_bed_only,
    }


def parse_lines(text_or_list):
    """Shortcuts sends one sample per line: 'value|start|end|source'. A JSON list of the same strings also works."""
    if isinstance(text_or_list, list):
        lines = [str(x) for x in text_or_list]
    else:
        lines = str(text_or_list or "").splitlines()
    out = []
    for line in lines:
        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 3 or not parts[1] or not parts[2]:
            continue
        try:
            out.append((parts[0], parse_dt(parts[1]), parse_dt(parts[2]), parts[3] if len(parts) > 3 else ""))
        except ValueError:
            continue
    return out


def workout_name(raw):
    """'HKWorkoutActivityTypeTraditionalStrengthTraining' -> 'Traditional Strength Training'."""
    name = re.sub(r"^HKWorkoutActivityType", "", raw or "Workout")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).strip()[:100] or "Workout"


def workout(name, start, end):
    return {"type": workout_name(name), "minutes": round(minutes(start, end)), "start": hhmm(start)}


# ---------- Merge into a day

def merge(old, fresh, synced_at=None, fill_only=False):
    """Returns the day's health object with fresh values. Hand corrections ("edited") are kept.
    fill_only=True (history import) only fills fields that are empty."""
    old = old or {}
    edited = old.get("edited") or []
    new = dict(old)
    for k, v in fresh.items():
        if v is None or k in edited:
            continue
        if fill_only and old.get(k) not in (None, [], {}):
            continue
        new[k] = v
    new["edited"] = edited
    new.setdefault("source", "apple")
    if synced_at:
        new["syncedAt"] = synced_at
    return new


def merge_health(uid, date_str, fresh, synced_at=None, fill_only=False):
    with db.transaction():
        new = merge(db.get_day(uid, date_str)["health"], fresh, synced_at, fill_only)
        db.save_day_part(uid, date_str, "health", new)
    return new


def _per_day(lines, field, integer=False):
    """'value|start|end' lines -> {date: average}, by the local date of each sample."""
    values = defaultdict(list)
    for v, s, _, _ in parse_lines(lines):
        n = plausible(field, _num(v, integer))
        if n is not None:
            values[s.date()].append(n)
    return {d: round(sum(x) / len(x)) for d, x in values.items()}


def ingest_shortcut(uid, p):
    """Handles the JSON that the iPhone shortcut sends. See docs/shortcut.md."""
    now = datetime.now(TZ)
    day = Date.fromisoformat(p["date"]) if p.get("date") else now.date()
    stamp = now.strftime("%Y-%m-%dT%H:%M")
    fresh = {}

    samples = [Sample(sleep_stage(v), s, e, src) for v, s, e, src in parse_lines(p.get("sleep"))]
    fresh["sleep"] = summarize_sleep([s for s in samples if night_of(s.end) == day])
    fresh["steps"] = plausible("steps", _num(p.get("steps"), integer=True))
    fresh["restingHr"] = plausible("restingHr", _num(p.get("resting_hr")))
    fresh["hrv"] = plausible("hrv", _num(p.get("hrv")))
    for k in ("steps", "restingHr", "hrv"):
        fresh[k] = round(fresh[k]) if fresh[k] is not None else None
    if p.get("workouts") is not None:
        fresh["workouts"] = [workout(v, s, e) for v, s, e, _ in parse_lines(p.get("workouts")) if s.date() == day]

    # One value per day ("value|start|end" lines from "Group By: Day"). Also corrects the last days.
    daily = defaultdict(dict)
    for key, field, integer in (("steps_days", "steps", True), ("resting_hr_days", "restingHr", False),
                                ("hrv_days", "hrv", False)):
        for d, v in _per_day(p.get(key), field, integer).items():
            daily[d][field] = v
    # Yesterday's final step count, sent the next morning.
    ys = plausible("steps", _num(p.get("steps_yesterday"), integer=True))
    if ys is not None:
        daily[day - timedelta(days=1)]["steps"] = round(ys)

    kg = parse_weight(p.get("weight"), p.get("weight_unit")) if p.get("weight") not in (None, "") else None

    with db.transaction():
        result = merge_health(uid, day.isoformat(), {**fresh, **daily.pop(day, {})}, synced_at=stamp)
        for d, values in sorted(daily.items()):
            if day - timedelta(days=7) <= d < day:
                merge_health(uid, d.isoformat(), values)
        if kg:
            if p.get("weight_date"):
                wdt = parse_dt(p["weight_date"])
                wdate, wtime, xid = wdt.date().isoformat(), hhmm(wdt), f"apple-weight-{wdt.isoformat(timespec='minutes')}"
            else:  # no time: keep one weight per day, not one per sync
                wdate, wtime, xid = day.isoformat(), None, f"apple-weight-{day.isoformat()}"
            db.add_measurement(uid, "weight", wdate, wtime, kg, "apple", xid)
        db.update_kv(uid, "settings", {"lastSync": stamp})
        db.touch_ingest(uid)
    return {"ok": True, "date": day.isoformat(), "health": result}


# ---------- Full export (export.zip from the Health app)

TYPES = {
    "HKQuantityTypeIdentifierStepCount": "steps",
    "HKQuantityTypeIdentifierRestingHeartRate": "restingHr",
    "HKQuantityTypeIdentifierHeartRateVariabilitySDNN": "hrv",
    "HKQuantityTypeIdentifierBodyMass": "weight",
    "HKCategoryTypeIdentifierSleepAnalysis": "sleep",
    "HKQuantityTypeIdentifierBloodPressureSystolic": "sys",
    "HKQuantityTypeIdentifierBloodPressureDiastolic": "dia",
    "HKQuantityTypeIdentifierBodyTemperature": "temp",
}
_TOO_BIG = "This file unpacks to too much data. Upload the export.zip from the Health app."


class _Limited:
    """Reads at most `limit` bytes, whatever the zip header says."""

    def __init__(self, fh, limit):
        self.fh, self.limit, self.count = fh, limit, 0

    def read(self, size=-1):
        data = self.fh.read(size if size and size > 0 else 1 << 16)
        self.count += len(data)
        if self.count > self.limit:
            raise ImportRefused(_TOO_BIG)
        return data


def _find_export_xml(zf):
    """export.xml has a different name in some languages. Take the largest XML that is not the CDA file."""
    xmls = [i for i in zf.infolist() if i.filename.lower().endswith(".xml") and "cda" not in i.filename.lower()]
    if not xmls:
        raise ImportRefused("No XML file found in the zip. Upload the export.zip from the Health app.")
    return max(xmls, key=lambda i: i.file_size)


def _to_kg(v, unit):
    return v * {"lb": LB, "st": STONE, "g": 0.001}.get(unit, 1)


def _read_export(fh):
    """Reads export.xml as a stream and returns everything the diary uses, grouped by day."""
    steps = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))  # day -> hour -> source -> sum
    hr, hrv = defaultdict(list), defaultdict(list)
    weights, temps, nights, workouts = [], [], defaultdict(list), defaultdict(list)
    bp = defaultdict(dict)  # time -> {sys, dia}

    depth, root = 0, None
    for event, el in iterparse(fh, events=("start", "end"), forbid_dtd=False):
        if event == "start":
            depth += 1
            root = root if root is not None else el
            continue
        depth -= 1
        if el.tag == "Record" and el.get("type") in TYPES:
            kind = TYPES[el.get("type")]
            start, end = parse_dt(el.get("startDate")), parse_dt(el.get("endDate"))
            if kind == "sleep":
                s = Sample(sleep_stage(el.get("value")), start, end, el.get("sourceName", ""))
                if s.stage:
                    nights[night_of(end)].append(s)
            else:
                v = _num(el.get("value"))
                d = start.date()
                if v is None:
                    pass
                elif kind == "steps":
                    steps[d][start.hour][el.get("sourceName", "")] += v
                elif kind == "restingHr" and plausible(kind, v):
                    hr[d].append(v)
                elif kind == "hrv" and plausible(kind, v):
                    hrv[d].append(v)
                elif kind == "weight" and plausible(kind, _to_kg(v, el.get("unit"))):
                    weights.append((start, round(_to_kg(v, el.get("unit")), 1)))
                elif kind in ("sys", "dia") and plausible(kind, v):
                    bp[start][kind] = round(v)
                elif kind == "temp":
                    c = round((v - 32) / 1.8 if el.get("unit") == "degF" else v, 1)
                    if plausible("temp", c):
                        temps.append((start, c))
        elif el.tag == "Workout":
            start, end = parse_dt(el.get("startDate")), parse_dt(el.get("endDate"))
            workouts[start.date()].append(workout(el.get("workoutActivityType"), start, end))
        if depth == 1:
            # Free each top-level element when it ends: the export can be several GB.
            root.clear()

    days = defaultdict(dict)
    for d, hours in steps.items():
        # iPhone and Watch both count steps. In each hour, take the source with the most
        # steps (not the sum), then add the hours: this keeps the steps of each device.
        days[d]["steps"] = plausible("steps", round(sum(max(src.values()) for src in hours.values())))
    for d, values in hr.items():
        days[d]["restingHr"] = round(sum(values) / len(values))
    for d, values in hrv.items():
        days[d]["hrv"] = round(sum(values) / len(values))
    for d, items in workouts.items():
        days[d]["workouts"] = items
    for d, samples in nights.items():
        days[d]["sleep"] = summarize_sleep(samples)

    def row(mtype, dt, value):
        return (mtype, dt.date().isoformat(), hhmm(dt), value, "apple", f"apple-{mtype}-{dt.isoformat(timespec='minutes')}")

    measurements = {
        "weight": [row("weight", dt, kg) for dt, kg in weights],
        "temp": [row("temp", dt, c) for dt, c in temps],
        "bp": [row("bp", dt, {"sys": v["sys"], "dia": v["dia"], "pulse": None})
               for dt, v in bp.items() if "sys" in v and "dia" in v],
    }
    return days, measurements


def import_export(uid, path):
    """Reads the Health app export (zip or xml) and fills days that have no data yet."""
    with ExitStack() as stack:
        if zipfile.is_zipfile(path):
            zf = stack.enter_context(zipfile.ZipFile(path))
            info = _find_export_xml(zf)
            if info.file_size > MAX_UNPACKED or (
                    info.file_size > 1024 * 1024 and info.file_size > MAX_RATIO * max(info.compress_size, 1)):
                raise ImportRefused(_TOO_BIG)
            fh = stack.enter_context(zf.open(info))
        else:
            fh = stack.enter_context(open(path, "rb"))
        days, measurements = _read_export(_Limited(fh, MAX_UNPACKED))

    dates = sorted(d.isoformat() for d in days)
    added = {}
    # One transaction: an import is saved completely, or not at all.
    with db.transaction():
        old = {d["date"]: d["health"] for d in db.list_days(uid, dates[0], dates[-1])} if dates else {}
        db.save_days_part(uid, "health", [(d.isoformat(), merge(old.get(d.isoformat()), fresh, fill_only=True))
                                          for d, fresh in days.items()])
        # The same value can be in the export twice. external_id makes the second one a no-op.
        for mtype, rows in measurements.items():
            n = db.add_measurements(uid, rows)
            if n > 0:
                added[mtype] = n
    return {"days": len(dates), "measurements": added,
            "first": dates[0] if dates else None, "last": dates[-1] if dates else None}
