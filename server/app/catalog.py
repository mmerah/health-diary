"""The user's own catalog: symptoms, document types, measurements and counters.

Built-in items stay as they are (weight, blood pressure, temperature; water, coffee, alcohol;
the document types). The user adds their own next to them. Own ids start with "c_".
normalize() gives the same result as normalizeCatalog() in web/js/core/schema.js.
"""
from . import db
from .models import BUILT_IN_TYPES, Catalog

KEY = "catalog"


def _unique(items):
    seen, out = set(), []
    for x in items:
        if x not in seen:
            seen.add(x)
            out.append(x)
    return out


def normalize(c: Catalog):
    out = {"v": 1}
    if c.symptoms is not None:  # not sent: the app uses its default list
        out["symptoms"] = _unique(x.strip() for x in c.symptoms if x.strip())
    out["docTypes"] = {
        "custom": _unique(x.strip() for x in c.docTypes.custom if x.strip() and x.strip() not in BUILT_IN_TYPES),
        "hidden": _unique(c.docTypes.hidden),
    }
    measurements, seen = [], set()
    for m in c.measurements:
        if m.id in seen:
            continue
        seen.add(m.id)
        lo = 0 if m.min is None else m.min
        hi = 100000 if m.max is None else m.max
        measurements.append({"id": m.id, "name": m.name, "unit": m.unit.strip(), "low": m.low, "high": m.high,
                             "min": min(lo, hi), "max": max(lo, hi), "step": m.step or 0.1, "hidden": m.hidden})
    out["measurements"] = measurements
    counters, seen = [], set()
    for x in c.counters:
        if x.id in seen:
            continue
        seen.add(x.id)
        counters.append({"id": x.id, "name": x.name, "one": x.one.strip() or "time",
                         "many": x.many.strip() or "times", "hidden": x.hidden})
    out["counters"] = counters
    return out


def get(uid):
    """The stored catalog, or None (the app then uses its defaults)."""
    return db.get_kv(uid, KEY, None)


def save(uid, c: Catalog):
    value = normalize(c)
    db.set_kv(uid, KEY, value)
    return value


def measurement(uid, mid):
    """One of the user's own measurements, hidden ones too (old values stay valid), or None."""
    return next((m for m in (get(uid) or {}).get("measurements", []) if m["id"] == mid), None)


def doc_types(uid):
    """All document types the user may set: built-in ones (hidden ones too) and their own."""
    return set(BUILT_IN_TYPES) | set(((get(uid) or {}).get("docTypes") or {}).get("custom", []))
