import io
import json
import zipfile

import pytest
from conftest import PW, login, new_client
from samples import TOOLS, password_pdf, render, scanned_pdf, text_pdf, webp

from app import auth, db, documents, main, paperless

needs_tools = pytest.mark.skipif(not TOOLS, reason="poppler-utils and tesseract are not installed")

LAB = ("Laboratoire Central\nBilan sanguin du 12/03/2026\nHémoglobine 14,2 g/dL\n"
       "Cholestérol total 5,2 mmol/L\nMARKER-ZQX-4471")


@pytest.fixture(autouse=True)
def fresh_limits():
    auth.reset_limits()


def upload(client, data, name="scan.pdf", **fields):
    return client.post("/api/documents", files={"file": (name, data, "application/octet-stream")}, data=fields)


def ready(client, doc_id):
    assert documents.wait_idle(300)
    return client.get(f"/api/documents/{doc_id}").json()


def files_under_data():
    return [p for p in db.DATA_DIR.rglob("*") if p.is_file()]


# ---------- Upload checks (no tools needed)

def test_upload_needs_a_session_and_writes_nothing(c):
    r = new_client().post("/api/documents", files={"file": ("a.pdf", b"%PDF-1.4" + b"0" * 50_000)})
    assert r.status_code == 401
    assert list(db.TMP_DIR.iterdir()) == [] and not (db.DATA_DIR / "documents").exists()


@pytest.mark.parametrize("data, name", [
    (b"<html><script>alert(1)</script></html>", "report.pdf"),  # the name says PDF; the bytes do not
    (b"GIF89a....", "x.gif"),
    (b"RIFF\x00\x00\x00\x00WAVEfmt ", "x.webp"),
    (b"", "empty.pdf"),
])
def test_only_pdf_and_images_by_their_bytes(c, data, name):
    r = upload(c, data, name)
    assert r.status_code == 400 and "PDF, JPEG, PNG or WebP" in r.json()["detail"]
    assert list(db.TMP_DIR.iterdir()) == []


def test_size_limit(c, monkeypatch):
    monkeypatch.setattr(documents, "MAX_DOC_MB", 1)
    r = upload(c, b"%PDF-" + b"0" * (1024 * 1024 + 100 * 1024))
    assert r.status_code == 413 and "1 MB" in r.json()["detail"]
    assert list(db.TMP_DIR.iterdir()) == []


def test_upload_rate_limit(c, monkeypatch):
    monkeypatch.setattr(auth, "DOC_UPLOAD", auth.Limiter(2, 3600))
    codes = [upload(c, b"nope").status_code for _ in range(3)]
    assert codes == [400, 400, 429]


def test_bad_fields_are_refused(c):
    for fields in ({"date": "2026-02-30"}, {"title": "x" * 201}):
        r = upload(c, b"%PDF-1.4", **fields)
        assert r.status_code == 400 and "not valid" in r.json()["detail"], fields
    r = upload(c, b"%PDF-1.4", category="Dentist")
    assert r.status_code == 400 and "not in your list" in r.json()["detail"]


def test_excluded_docs_take_both_id_kinds(c):
    assert c.put("/api/settings", json={"excludedDocs": [12, "d3"]}).status_code == 204
    assert c.get("/api/settings").json()["excludedDocs"] == [12, "d3"]
    assert c.put("/api/settings", json={"excludedDocs": ["x3"]}).status_code == 400


# ---------- Reading the text (poppler and tesseract)

@needs_tools
def test_text_pdf_is_read_and_suggestions_are_made(c):
    r = upload(c, text_pdf([LAB]), "Bilan_sanguin-mars.pdf")
    assert r.status_code == 201
    doc = r.json()
    assert doc["status"] == "processing" and doc["id"].startswith("d") and doc["source"] == "diary"
    assert doc["title"] == "Bilan sanguin mars" and doc["category"] == "" and doc["correspondent"] == ""
    assert doc["url"] == f"/api/documents/{doc['id']}/file" and doc["pages"] == 1
    doc = ready(c, doc["id"])
    assert doc["status"] == "ready" and doc["error"] is None
    assert "Hémoglobine 14,2" in doc["content"] and "MARKER-ZQX-4471" in doc["content"]
    assert doc["suggested"] == {"category": "Blood test", "date": "2026-03-12", "title": "Bilan sanguin du 12/03/2026"}
    assert doc["edited"] == []


@needs_tools
@pytest.mark.parametrize("kind", ["png", "jpeg", "webp", "scan"])
def test_ocr_of_images_and_scans(c, kind):
    text = "Cholesterol total 5.2 mmol/L\nFerritin 80 ng/mL"
    data = {"png": lambda: render(text_pdf([text]), "png"), "jpeg": lambda: render(text_pdf([text]), "jpeg"),
            "webp": lambda: webp(text), "scan": lambda: scanned_pdf(text)}[kind]()
    doc = ready(c, upload(c, data, f"photo.{kind}").json()["id"])
    assert doc["status"] == "ready", doc["error"]
    assert "Cholesterol total 5.2" in doc["content"] and "Ferritin" in doc["content"]
    assert doc["suggested"]["category"] == "Blood test"


@needs_tools
def test_pdf_page_limit_and_password(c):
    r = upload(c, text_pdf([f"Page {i}" for i in range(documents.MAX_PAGES + 1)]))
    assert r.status_code == 400 and f"more than {documents.MAX_PAGES} pages" in r.json()["detail"]
    r = upload(c, password_pdf())
    assert r.status_code == 400 and "password" in r.json()["detail"]
    r = upload(c, b"%PDF-1.4\nnot really a pdf")
    assert r.status_code == 400 and "Could not read this PDF" in r.json()["detail"]
    assert list(db.TMP_DIR.iterdir()) == []


@needs_tools
def test_failed_reading_can_be_retried(c):
    doc = ready(c, upload(c, b"\x89PNG\r\n\x1a\n" + b"broken" * 100, "x.png").json()["id"])
    assert doc["status"] == "failed" and doc["error"].startswith("Could not read the text")
    r = c.post(f"/api/documents/{doc['id']}/retry")
    assert r.status_code == 200 and r.json()["status"] == "processing"
    assert ready(c, doc["id"])["status"] == "failed"


@needs_tools
def test_time_limit(c, monkeypatch):
    monkeypatch.setattr(documents, "TOTAL_TIMEOUT", 0)
    doc = ready(c, upload(c, text_pdf(["Timeout test"])).json()["id"])
    assert doc["status"] == "failed" and "too long" in doc["error"]


@needs_tools
def test_memory_limit_stops_a_tool(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "OCR_MEMORY_MB", 200)
    r = documents.run(["python3", "-c", "x = bytearray(500 * 1024 * 1024)"], 30, tmp_path)
    assert r.returncode != 0


@needs_tools
def test_documents_left_processing_are_read_at_start(c):
    doc = upload(c, text_pdf(["Restart test, enough text to be read without OCR here."])).json()
    assert documents.wait_idle(300)
    did = documents.diary_id(doc["id"])
    db.update_document(did, status="processing", content=None)
    documents.requeue()  # what start() does after a restart
    assert ready(c, doc["id"])["status"] == "ready"


@needs_tools
def test_nothing_is_stored_in_plain_text(c):
    pdf = text_pdf([LAB])
    doc = ready(c, upload(c, pdf, "x.pdf").json()["id"])
    assert "MARKER-ZQX-4471" in doc["content"]
    chunk = pdf[200:400]
    for f in files_under_data():
        data = f.read_bytes()
        assert b"MARKER-ZQX-4471" not in data and chunk not in data, f
    stored = documents.file_path(c.get("/api/auth/status").json()["user"]["id"], documents.diary_id(doc["id"]))
    assert stored.stat().st_mode & 0o777 == 0o600 and stored.parent.stat().st_mode & 0o777 == 0o700
    assert list(db.TMP_DIR.iterdir()) == []


# ---------- Changes, files, ownership

@pytest.fixture(scope="module")
def doc_id(c):
    if not TOOLS:
        pytest.skip("poppler-utils and tesseract are not installed")
    doc = upload(c, text_pdf([LAB]), "lab.pdf", date="2026-03-01", category="Blood test").json()
    assert doc["edited"] == ["category", "date"]
    ready(c, doc["id"])
    return doc["id"]


def test_patch_diary_document(c, doc_id):
    doc = c.get(f"/api/documents/{doc_id}").json()
    # Category and date were given at upload: only the title is still suggested.
    assert doc["suggested"] == {"title": "Bilan sanguin du 12/03/2026"}
    doc = c.patch(f"/api/documents/{doc_id}", json={"title": "Bilan sanguin du 12/03/2026"}).json()
    assert doc["title"] == "Bilan sanguin du 12/03/2026" and doc["suggested"] is None
    assert doc["edited"] == ["category", "date", "title"]
    # null category: "not set" again, and the suggestion comes back.
    doc = c.patch(f"/api/documents/{doc_id}", json={"category": None}).json()
    assert doc["category"] == "" and doc["suggested"] == {"category": "Blood test"}
    assert c.patch(f"/api/documents/{doc_id}", json={"date": None}).status_code == 400
    assert c.patch(f"/api/documents/{doc_id}", json={"category": "Dentist"}).status_code == 400
    assert c.patch(f"/api/documents/{doc_id}", json={"owner": 2}).status_code == 400
    assert c.patch(f"/api/documents/{doc_id}", json={"category": "Blood test"}).json()["category"] == "Blood test"


def test_file_endpoint(c, doc_id):
    r = c.get(f"/api/documents/{doc_id}/file")
    assert r.status_code == 200 and r.content.startswith(b"%PDF-")
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"] == 'inline; filename="Bilan sanguin du 12032026.pdf"'
    assert r.headers["x-content-type-options"] == "nosniff" and r.headers["cache-control"] == "no-store"
    # PDFs: strict, but no sandbox (browsers show no PDF in a sandboxed page). Images keep the sandbox.
    assert "sandbox" not in r.headers["content-security-policy"]
    assert "default-src 'none'" in r.headers["content-security-policy"]
    assert c.get("/api/documents/d999999/file").status_code == 404


def test_other_users_cannot_touch_a_document(c, doc_id):
    c.post("/api/users", json={"username": "ben", "password": PW})
    ben = login("ben")
    for r in (ben.get(f"/api/documents/{doc_id}"), ben.get(f"/api/documents/{doc_id}/file"),
              ben.patch(f"/api/documents/{doc_id}", json={"title": "mine"}),
              ben.delete(f"/api/documents/{doc_id}"), ben.post(f"/api/documents/{doc_id}/retry")):
        assert r.status_code == 404
    assert ben.get("/api/documents").json()["documents"] == []
    assert c.get(f"/api/documents/{doc_id}").json()["title"] != "mine"


def test_export_is_a_zip_with_the_documents(c, doc_id):
    r = c.get("/api/me/export")
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    assert r.headers["content-disposition"].startswith('attachment; filename="health-diary-anna-')
    assert r.headers["content-disposition"].split(";")[1].strip().endswith('.zip"')
    z = zipfile.ZipFile(io.BytesIO(r.content))
    data = json.loads(z.read("data.json"))
    assert data["version"] == 2
    entry = next(d for d in data["documents"] if d["id"] == doc_id)
    assert "MARKER-ZQX-4471" in entry["content"]
    assert z.read(entry["file"]).startswith(b"%PDF-") and entry["file"].startswith(f"documents/{doc_id}-")
    assert list(db.TMP_DIR.iterdir()) == []


def test_delete_removes_file_row_and_exclusion(c, doc_id):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    path = documents.file_path(uid, documents.diary_id(doc_id))
    c.put("/api/settings", json={"excludedDocs": [5, doc_id]})
    assert path.exists()
    assert c.delete(f"/api/documents/{doc_id}").status_code == 204
    assert not path.exists() and c.get(f"/api/documents/{doc_id}").status_code == 404
    assert c.get("/api/settings").json()["excludedDocs"] == [5]


@needs_tools
def test_deleting_a_user_deletes_their_files(c):
    c.post("/api/users", json={"username": "cleo", "password": PW})
    cleo = login("cleo")
    upload(cleo, text_pdf(["Cleo document with enough text to be read directly."]))
    documents.wait_idle(300)
    uid = cleo.get("/api/auth/status").json()["user"]["id"]
    assert (db.DATA_DIR / "documents" / str(uid)).exists()
    assert c.delete(f"/api/users/{uid}").status_code == 204
    assert not (db.DATA_DIR / "documents" / str(uid)).exists()


# ---------- Paperless documents, with the user's own settings

PAPERLESS = [
    {"id": 7, "date": "2026-05-01", "title": "Scan 0042", "type": None, "correspondent": "Lab",
     "content": "Hémoglobine 13 g/dL, ferritine 50, prélevé le 28/04/2026", "url": "http://p/documents/7/details",
     "added": "2026-05-02T10:00:00"},
    {"id": 8, "date": "2026-06-01", "title": "Letter", "type": "Blood test", "correspondent": "",
     "content": "Cholesterol", "url": "http://p/documents/8/details", "added": None},
    {"id": 9, "date": "2026-07-01", "title": "Befund", "type": "Laborbefund", "correspondent": "",
     "content": "Blutbild: Leukozyten normal", "url": "http://p/documents/9/details", "added": None},
]


@pytest.fixture
def fake_paperless(monkeypatch):
    state = {"items": [dict(i) for i in PAPERLESS], "error": None}

    def fake_list(uid, force=False):
        if state["error"]:
            raise paperless.PaperlessError(state["error"])
        return [dict(i) for i in state["items"]]
    monkeypatch.setattr(paperless, "list_documents", fake_list)
    monkeypatch.setattr(paperless, "configured", lambda uid: True)
    return state


def test_paperless_documents_in_the_list(c, fake_paperless):
    r = c.get("/api/documents").json()
    assert r["paperless"] == {"ok": True, "error": None}
    docs = {d["id"]: d for d in r["documents"] if d["source"] == "paperless"}
    d7, d8, d9 = docs[7], docs[8], docs[9]
    assert d7["category"] == "" and d7["paperlessType"] is None and d7["edited"] == []
    assert d7["suggested"]["category"] == "Blood test" and d7["suggested"]["date"] == "2026-04-28"
    assert d8["category"] == "Blood test" and d8["suggested"] is None  # a type of ours: no suggestion
    assert d9["category"] == "Laborbefund" and d9["suggested"]["category"] == "Blood test"
    dates = [d["date"] for d in r["documents"]]
    assert dates == sorted(dates, reverse=True)
    for d in r["documents"]:
        assert set(d) >= {"id", "source", "date", "title", "category", "correspondent", "content", "url", "status",
                          "error", "pages", "suggested", "createdAt"}


def test_paperless_error_does_not_fail_the_list(c, fake_paperless):
    fake_paperless["error"] = "Cannot reach Paperless. Ask the administrator to check PAPERLESS_URL."
    r = c.get("/api/documents")
    assert r.status_code == 200
    assert r.json()["paperless"] == {"ok": False, "error": fake_paperless["error"]}


def test_paperless_overrides(c, fake_paperless):
    d = c.patch("/api/documents/7", json={"category": "Imaging", "title": "Knee MRI"}).json()
    assert (d["category"], d["title"], d["edited"]) == ("Imaging", "Knee MRI", ["category", "title"])
    assert d["suggested"] == {"date": "2026-04-28"}  # fields the user set are not offered again
    d = c.patch("/api/documents/7", json={"date": "2026-04-28"}).json()
    assert d["date"] == "2026-04-28" and d["suggested"] is None
    # null gives back the Paperless value; omitted fields stay.
    d = c.patch("/api/documents/7", json={"title": None}).json()
    assert (d["title"], d["category"], d["edited"]) == ("Scan 0042", "Imaging", ["category", "date"])
    assert c.patch("/api/documents/7", json={"category": "Dentist"}).status_code == 400
    assert c.patch("/api/documents/99", json={"category": "Imaging"}).status_code == 404
    assert c.delete("/api/documents/7").json()["detail"] == "Delete it in Paperless."
    assert c.get("/api/documents/7").json()["category"] == "Imaging"
    # Another user's settings are their own.
    c.post("/api/users", json={"username": "dora", "password": PW})
    dora = login("dora")
    assert dora.get("/api/documents/7").json()["category"] == ""
    dora.patch("/api/documents/7", json={"category": "Prescription"})
    assert c.get("/api/documents/7").json()["category"] == "Imaging"


def test_paperless_overrides_are_kept_when_a_document_leaves_the_list(c, fake_paperless):
    uid = c.get("/api/auth/status").json()["user"]["id"]
    c.patch("/api/documents/8", json={"title": "Lipids"})
    fake_paperless["error"] = "down"
    c.get("/api/documents")
    assert "8" in db.get_kv(uid, documents.META_KEY, {})
    fake_paperless["error"] = None
    removed = [i for i in fake_paperless["items"] if i["id"] == 8]
    fake_paperless["items"] = [i for i in fake_paperless["items"] if i["id"] != 8]
    c.get("/api/documents")  # for example, the tag was renamed for a while
    assert "8" in db.get_kv(uid, documents.META_KEY, {})
    fake_paperless["items"] += removed
    doc = next(d for d in c.get("/api/documents").json()["documents"] if d["id"] == 8)
    assert doc["title"] == "Lipids" and "title" in doc["edited"]


def test_routes_are_registered(c):
    paths = {(r.path, m) for r in main.app.routes for m in getattr(r, "methods", ())}
    for p in [("/api/documents", "GET"), ("/api/documents", "POST"), ("/api/documents/{doc_id}", "GET"),
              ("/api/documents/{doc_id}", "PATCH"), ("/api/documents/{doc_id}", "DELETE"),
              ("/api/documents/{doc_id}/file", "GET"), ("/api/documents/{doc_id}/retry", "POST")]:
        assert p in paths


# ---------- The user's own document types

def test_own_document_types(c, fake_paperless):
    c.put("/api/catalog", json={"docTypes": {"custom": ["Dentist"], "hidden": ["Imaging"]}})
    assert c.patch("/api/documents/7", json={"category": "Dentist"}).json()["category"] == "Dentist"
    assert c.patch("/api/documents/7", json={"category": "Imaging"}).json()["category"] == "Imaging"  # hidden: still valid
    r = c.patch("/api/documents/7", json={"category": "Optician"})
    assert r.status_code == 400 and "not in your list" in r.json()["detail"]
    r = upload(c, b"not a pdf", category="Optician")
    assert r.status_code == 400 and "not in your list" in r.json()["detail"]
    # Another user does not have "Dentist".
    c.post("/api/users", json={"username": "hugo", "password": PW})
    assert login("hugo").patch("/api/documents/7", json={"category": "Dentist"}).status_code == 400


@needs_tools
def test_upload_with_an_own_type(c):
    c.put("/api/catalog", json={"docTypes": {"custom": ["Dentist"]}})
    doc = upload(c, text_pdf(["Dental check"]), category="Dentist").json()
    assert doc["category"] == "Dentist" and "category" in doc["edited"]


# ---------- Encrypted storage in chunks

def test_large_files_are_stored_in_chunks(c, tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "CHUNK", 1000)
    uid = c.get("/api/auth/status").json()["user"]["id"]
    src = tmp_path / "big.bin"
    data = bytes(range(256)) * 40  # 10 240 bytes: 11 chunks
    src.write_bytes(data)
    documents.store_file(uid, 900001, src)
    stored = documents.file_path(uid, 900001).read_bytes()
    assert stored.startswith(documents.MAGIC) and data[:100] not in stored
    assert list(documents.iter_file(uid, 900001)) == [data[i:i + 1000] for i in range(0, len(data), 1000)]
    # A cut file, or one with an extra chunk, is refused.
    path = documents.file_path(uid, 900001)
    path.write_bytes(stored[:-200])
    with pytest.raises(documents.Damaged):
        documents.read_file(uid, 900001)
    path.write_bytes(stored + b"\x00\x00\x00\x05hello")
    with pytest.raises(documents.Damaged):
        documents.read_file(uid, 900001)
    # Chunks in another order are refused.
    first_len = int.from_bytes(stored[4:8], "big")
    first = stored[4:8 + first_len]
    second_len = int.from_bytes(stored[8 + first_len:12 + first_len], "big")
    second = stored[8 + first_len:12 + first_len + second_len]
    path.write_bytes(documents.MAGIC + second + first + stored[12 + first_len + second_len:])
    with pytest.raises(documents.Damaged):
        documents.read_file(uid, 900001)
    # Empty files work too.
    (tmp_path / "empty").write_bytes(b"")
    documents.store_file(uid, 900002, tmp_path / "empty")
    assert documents.read_file(uid, 900002) == b""
    # A file in another format is refused.
    documents.file_path(uid, 900001).write_bytes(b"%PDF-1.4 not encrypted")
    with pytest.raises(documents.Damaged):
        documents.read_file(uid, 900001)
    documents.remove_file(uid, 900001)
    documents.remove_file(uid, 900002)
