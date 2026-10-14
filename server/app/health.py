"""Apple Health data: the payload of the iPhone shortcut, and the full export.zip.

Both paths end in the same per-day "health" object that the front end shows:
  { sleep: {total, deep, rem, core, awake, bed, wake}, steps, restingHr, hrv,
    workouts: [{type, minutes, start}], source: 'apple', syncedAt, edited: [...] }
Fields listed in "edited" were corrected by hand. A sync or an import never overwrites them.
"""
import os
import re
import zipfile
from collections import defaultdict
from datetime import date as Date, datetime, time as Time, timedelta
from xml.etree.ElementTree import iterparse
from zoneinfo import ZoneInfo

from . import db

TZ = ZoneInfo(os.environ.get("TZ", "UTC"))

# ---------- Sleep

ASLEEP = ("core", "deep", "rem", "asleep")


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


def parse_dt(s):
    """Parses ISO 8601 (from Shortcuts) and '2026-10-14 07:30:00 +0200' (from export.xml). Returns local time."""
    s = s.strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$", s)
    if m:
        s = f"{m[1]}T{m[2]}{m[3]}:{m[4]}"
    dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


def summarize_sleep(samples, day):
    """samples: [(stage, start, end, source)]. The night of `day` is everything that ends
    between 18:00 the day before and 18:00 on `day`."""
    lo = datetime.combine(day - timedelta(days=1), Time(18, 0), TZ)
    hi = datetime.combine(day, Time(18, 0), TZ)
    night = [s for s in samples if s[0] and lo < s[2] <= hi]
    if not night:
        return None
    # iPhone and Watch both record sleep. Use one source: the one with sleep stages, then the longest.
    by_src = defaultdict(list)
    for s in night:
        by_src[s[3] or ""].append(s)

    def score(items):
        has_stages = any(i[0] in ("core", "deep", "rem") for i in items)
        asleep = sum((i[2] - i[1]).total_seconds() for i in items if i[0] in ASLEEP)
        return (has_stages, asleep)

    items = max(by_src.values(), key=score)
    mins = defaultdict(float)
    for stage, start, end, _ in items:
        mins[stage] += (end - start).total_seconds() / 60
    asleep_items = [i for i in items if i[0] in ASLEEP]
    if not asleep_items:
        return None
    total = sum(mins[k] for k in ASLEEP)
    has_stages = any(mins[k] for k in ("core", "deep", "rem"))
    first = min(i[1] for i in asleep_items)
    last = max(i[2] for i in asleep_items)
    awake = sum((e - s).total_seconds() / 60 for st, s, e, _ in items if st == "awake" and s >= first and e <= last)
    return {
        "total": round(total),
        "deep": round(mins["deep"]) if has_stages else None,
        "rem": round(mins["rem"]) if has_stages else None,
        "core": round(mins["core"]) if has_stages else None,
        "awake": round(awake),
        "bed": first.strftime("%H:%M"),
        "wake": last.strftime("%H:%M"),
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
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).strip() or "Workout"


# ---------- Merge into a day

def merge_health(uid, date_str, fresh, synced_at=None, fill_only=False):
    """Writes fresh values into the day. Hand corrections are kept.
    fill_only=True (history import) only fills fields that are empty."""
    old = db.get_day(uid, date_str)["health"] or {}
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
    db.save_day_part(uid, date_str, "health", new)
    return new


def _num(x):
    """Reads numbers as Shortcuts may send them: 2140, "2 140" (French), "46,7", "76.9 kg"."""
    if isinstance(x, (int, float)):
        return float(x)
    s = re.sub(r"(?<=\d)[\s  '](?=\d{3}\b)", "", str(x or "")).replace(",", ".")
    m = re.search(r"-?\d+(?:\.\d+)?", s)
    return float(m[0]) if m else None


def ingest_shortcut(uid, p):
    """Handles the JSON that the iPhone shortcut sends. See docs/shortcut.md."""
    now = datetime.now(TZ)
    day = Date.fromisoformat(p["date"]) if p.get("date") else now.date()
    stamp = now.strftime("%Y-%m-%dT%H:%M")
    fresh = {}

    samples = [(sleep_stage(v), s, e, src) for v, s, e, src in parse_lines(p.get("sleep"))]
    sleep = summarize_sleep(samples, day)
    if sleep:
        fresh["sleep"] = sleep
    for key, field in (("steps", "steps"), ("resting_hr", "restingHr"), ("hrv", "hrv")):
        v = _num(p.get(key))
        if v is not None:
            fresh[field] = round(v)
    if p.get("workouts") is not None:
        fresh["workouts"] = [
            {"type": workout_name(v), "minutes": round((e - s).total_seconds() / 60), "start": s.strftime("%H:%M")}
            for v, s, e, _ in parse_lines(p.get("workouts")) if s.date() == day
        ]
    result = merge_health(uid, day.isoformat(), fresh, synced_at=stamp)

    # Steps per day ("value|start|end" lines from "Group By: Day"). Corrects yesterday's final count too.
    for v, s, _, _ in parse_lines(p.get("steps_days")):
        n = _num(v)
        if n is not None:
            d = s.date()
            if d == day:
                result = merge_health(uid, day.isoformat(), {"steps": round(n)}, synced_at=stamp)
            elif day - timedelta(days=7) <= d < day:
                merge_health(uid, d.isoformat(), {"steps": round(n)})

    # Yesterday's final step count, sent the next morning.
    ys = _num(p.get("steps_yesterday"))
    if ys is not None:
        merge_health(uid, (day - timedelta(days=1)).isoformat(), {"steps": round(ys)})

    w = _num(p.get("weight"))
    if w:
        wdt = parse_dt(p["weight_date"]) if p.get("weight_date") else now
        db.add_measurement(uid, "weight", wdt.date().isoformat(), wdt.strftime("%H:%M"), round(w, 1), "apple",
                           f"apple-weight-{wdt.isoformat(timespec='minutes')}")

    settings = db.get_kv(uid, "settings", {})
    settings["lastSync"] = stamp
    db.set_kv(uid, "settings", settings)
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


def _find_export_xml(zf):
    """export.xml has a different name in some languages. Take the largest XML that is not the CDA file."""
    xmls = [i for i in zf.infolist() if i.filename.lower().endswith(".xml") and "cda" not in i.filename.lower()]
    if not xmls:
        raise ValueError("No XML file found in the zip. Upload the export.zip from the Health app.")
    return max(xmls, key=lambda i: i.file_size).filename


def import_export(uid, path):
    """Reads the Health app export (zip or xml) and fills days that have no data yet."""
    if zipfile.is_zipfile(path):
        zf = zipfile.ZipFile(path)
        fh = zf.open(_find_export_xml(zf))
    else:
        fh = open(path, "rb")

    steps = defaultdict(lambda: defaultdict(float))  # day -> source -> sum
    hr, hrv = defaultdict(list), defaultdict(list)
    weights, temps, sleep, workouts = [], [], [], defaultdict(list)
    bp = defaultdict(dict)  # start time -> {sys, dia}

    with fh:
        context = iterparse(fh, events=("start", "end"))
        _, root = next(context)
        for event, el in context:
            if event != "end":
                continue
            tag = el.tag
            if tag == "Record":
                kind = TYPES.get(el.get("type"))
                if kind:
                    start, end = parse_dt(el.get("startDate")), parse_dt(el.get("endDate"))
                    if kind == "sleep":
                        sleep.append((sleep_stage(el.get("value")), start, end, el.get("sourceName", "")))
                    else:
                        v = _num(el.get("value"))
                        if v is not None:
                            d = start.date().isoformat()
                            if kind == "steps":
                                steps[d][el.get("sourceName", "")] += v
                            elif kind == "restingHr":
                                hr[d].append(v)
                            elif kind == "hrv":
                                hrv[d].append(v)
                            elif kind == "weight":
                                kg = v * 0.45359237 if el.get("unit") == "lb" else v
                                weights.append((start, round(kg, 1)))
                            elif kind in ("sys", "dia"):
                                bp[start][kind] = round(v)
                            elif kind == "temp":
                                c = (v - 32) / 1.8 if el.get("unit") == "degF" else v
                                temps.append((start, round(c, 1)))
                root.clear()
            elif tag == "Workout":
                start, end = parse_dt(el.get("startDate")), parse_dt(el.get("endDate"))
                workouts[start.date().isoformat()].append({
                    "type": workout_name(el.get("workoutActivityType")),
                    "minutes": round((end - start).total_seconds() / 60),
                    "start": start.strftime("%H:%M"),
                })
                root.clear()
            elif tag in ("ActivitySummary", "ClinicalRecord", "Correlation"):
                # Free memory: the export can be several hundred MB.
                root.clear()

    sleep_days = {s[2].date() for s in sleep if s[0]}
    days = set(steps) | set(hr) | set(hrv) | set(workouts) | {d.isoformat() for d in sleep_days}
    for d in sorted(days):
        fresh = {
            # iPhone and Watch both count steps. Take the source with the most steps, not the sum.
            "steps": round(max(steps[d].values())) if d in steps else None,
            "restingHr": round(sum(hr[d]) / len(hr[d])) if hr.get(d) else None,
            "hrv": round(sum(hrv[d]) / len(hrv[d])) if hrv.get(d) else None,
            "workouts": workouts.get(d),
            "sleep": summarize_sleep(sleep, Date.fromisoformat(d)) if Date.fromisoformat(d) in sleep_days else None,
        }
        merge_health(uid, d, fresh, fill_only=True)

    # The same value can be in the export twice. external_id makes the second one a no-op.
    added = defaultdict(int)
    rows = [("weight", dt, kg) for dt, kg in weights] + [("temp", dt, c) for dt, c in temps] + \
           [("bp", dt, {"sys": v["sys"], "dia": v["dia"], "pulse": None}) for dt, v in bp.items() if "sys" in v and "dia" in v]
    for mtype, dt, value in rows:
        if db.add_measurement(uid, mtype, dt.date().isoformat(), dt.strftime("%H:%M"), value, "apple",
                              f"apple-{mtype}-{dt.isoformat(timespec='minutes')}"):
            added[mtype] += 1
    return {"days": len(days), "measurements": dict(added),
            "first": min(days) if days else None, "last": max(days) if days else None}
