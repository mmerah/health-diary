"""Lists that the front end (web/js/core/schema.js) and the server both hold. If one side changes,
these tests fail until the other side is updated."""
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from app import models, suggest

SCHEMA_JS = Path(__file__).resolve().parents[2] / "web" / "js" / "core" / "schema.js"
pytestmark = pytest.mark.skipif(not SCHEMA_JS.exists(), reason="web/ is not here")


def js():
    return SCHEMA_JS.read_text(encoding="utf-8")


def test_document_types():
    m = re.search(r"export const DOC_CATEGORIES = \[(.*?)\];", js(), re.S)
    names = re.findall(r"'([^']*)'", m[1])
    assert names == list(models.BUILT_IN_TYPES) == suggest.CATEGORIES


def accepts(model, data):
    try:
        model.model_validate(data)
        return True
    except ValidationError:
        return False


def test_built_in_measurements_and_their_limits():
    m = re.search(r"export const MEASUREMENTS = \{(.*?)\n\};", js(), re.S)
    body = m[1]
    assert re.findall(r"(?m)^  (\w+): \{", body) == ["weight", "bp", "temp"]
    limits = {k: (float(lo), float(hi)) for k, lo, hi in
              re.findall(r"key: '(\w+)', label: '[^']*', min: ([\d.]+), max: ([\d.]+)", body)}
    base = {"date": "2026-01-01"}

    def same(model, wrap, lo, hi):
        """The server accepts exactly lo..hi."""
        return (accepts(model, {**base, **wrap(lo)}) and accepts(model, {**base, **wrap(hi)})
                and not accepts(model, {**base, **wrap(lo - 0.5)}) and not accepts(model, {**base, **wrap(hi + 0.5)}))
    assert same(models.WeightIn, lambda v: {"type": "weight", "value": v}, *limits["kg"])
    assert same(models.TemperatureIn, lambda v: {"type": "temp", "value": v}, *limits["c"])
    bp = {"sys": 120, "dia": 80, "pulse": 60}
    for key in ("sys", "dia", "pulse"):
        lo, hi = limits[key]
        assert accepts(models.BloodPressure, {**bp, key: int(lo)}) and accepts(models.BloodPressure, {**bp, key: int(hi)})
        assert not accepts(models.BloodPressure, {**bp, key: int(lo) - 1}), key
        assert not accepts(models.BloodPressure, {**bp, key: int(hi) + 1}), key


def test_catalog_id_and_limits():
    text = js()
    assert re.search(r"export const CUSTOM_ID = /(.*?)/;", text)[1] == models.CUSTOM_ID
    n = int(re.search(r"const MAX_ITEMS = (\d+);", text)[1])
    lengths = {k: int(v) for k, v in re.findall(r"text\((x|m\.name|m\.unit|x\.name|x\.one|x\.many), (\d+)\)", text)}
    # text(x, 100) is a symptom; text(x, 60) an own document type (both written "x").
    symptom, doc_type = sorted({int(v) for v in re.findall(r"text\(x, (\d+)\)", text)}, reverse=True)

    def ok(data):
        return accepts(models.Catalog, data)
    m = {"id": "c_ab", "name": "x"}
    c = {"id": "c_ab", "name": "x"}
    assert ok({"symptoms": ["s"] * n}) and not ok({"symptoms": ["s"] * (n + 1)})
    assert ok({"symptoms": ["s" * symptom]}) and not ok({"symptoms": ["s" * (symptom + 1)]})
    assert ok({"docTypes": {"custom": ["t" * doc_type]}}) and not ok({"docTypes": {"custom": ["t" * (doc_type + 1)]}})
    many = [{"id": f"c_m{i:03d}", "name": "x"} for i in range(n + 1)]
    assert ok({"measurements": many[:n]}) and not ok({"measurements": many})
    assert ok({"counters": many[:n]}) and not ok({"counters": many})
    for field, size in (("name", lengths["m.name"]), ("unit", lengths["m.unit"])):
        assert ok({"measurements": [{**m, field: "u" * size}]}) and not ok({"measurements": [{**m, field: "u" * (size + 1)}]})
    for field, size in (("name", lengths["x.name"]), ("one", lengths["x.one"]), ("many", lengths["x.many"])):
        assert ok({"counters": [{**c, field: "u" * size}]}) and not ok({"counters": [{**c, field: "u" * (size + 1)}]})
