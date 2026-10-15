"""Documents kept in the diary, for users without Paperless.

The file is stored encrypted: $DATA_DIR/documents/<user id>/<document id>.bin. A background
worker reads the text: pdftotext for PDF pages with text, and tesseract (OCR) for scans and
photos. The text and the suggestions (suggest.py) are stored encrypted in the database.

Every external tool runs without a shell, with a time limit and a memory limit, in a private
folder under $DATA_DIR/tmp. The decrypted file exists only in that folder, only while it is read.
"""
import json
import logging
import os
import queue
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from datetime import datetime

from cryptography.fernet import InvalidToken

from . import crypto, db, paperless, suggest
from .health import TZ

log = logging.getLogger("uvicorn.error")

MAX_DOC_MB = 200
MAX_PAGES = 300
OCR_WORKERS = 1  # one document at a time: OCR uses a full CPU core
OCR_LANGS = "eng+fra+deu"  # the languages installed in the image
OCR_MEMORY_MB = 1024  # for each run of a tool
PAGE_TIMEOUT = 120  # seconds for each tool run (one page)
TOTAL_TIMEOUT = 2 * 60 * 60  # seconds for one document: 300 scanned pages take about 30 minutes
MIN_PAGE_TEXT = 40  # a PDF page with less text is probably a scan: read it with OCR

KINDS = {"pdf": ("application/pdf", "pdf"), "jpeg": ("image/jpeg", "jpg"),
         "png": ("image/png", "png"), "webp": ("image/webp", "webp")}


class Refused(ValueError):
    """The upload is refused. The message is plain text for the user."""


class ToolFailed(Exception):
    pass


def kind_of(head):
    """The file type from its first bytes. The name and the Content-Type sent by the browser do not count."""
    if head.startswith(b"%PDF-"):
        return "pdf"
    if head.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    return None


# ---------- Files

def folder(uid):
    root = db.DATA_DIR / "documents"
    path = root / str(uid)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    return path


def file_path(uid, doc_id):
    return folder(uid) / f"{doc_id}.bin"


# File format: MAGIC, then chunks of [4-byte length][Fernet token]. Each token holds the chunk
# number, a "last chunk" flag and up to 4 MB of the file. So a 200 MB file never sits in memory,
# and a file with chunks removed, cut or swapped is refused, not misread.
MAGIC, CHUNK = b"HDF1", 4 * 1024 * 1024


class Damaged(Exception):
    """The stored file is cut, changed, or the key is not the right one."""


def store_file(uid, doc_id, src):
    """Encrypts the file at `src` into the user's folder."""
    dest = file_path(uid, doc_id)
    tmp = dest.with_suffix(".part")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with open(src, "rb") as f, os.fdopen(fd, "wb") as out:
        out.write(MAGIC)
        index, data = 0, f.read(CHUNK)
        while True:
            following = f.read(CHUNK) if data else b""
            last = not following
            token = crypto.encrypt_bytes(struct.pack(">QB", index, last) + data)
            out.write(struct.pack(">I", len(token)) + token)
            if last:
                break
            index, data = index + 1, following
    tmp.replace(dest)


def iter_file(uid, doc_id):
    """Yields the decrypted file in chunks. Raises Damaged."""
    try:
        with open(file_path(uid, doc_id), "rb") as f:
            if f.read(4) != MAGIC:
                raise Damaged("not a diary file")
            index = 0
            while True:
                head = f.read(4)
                if len(head) != 4:
                    raise Damaged("cut")
                plain = crypto.decrypt_bytes(f.read(struct.unpack(">I", head)[0]))
                number, last = struct.unpack(">QB", plain[:9])
                if number != index:
                    raise Damaged("chunks in the wrong order")
                yield plain[9:]
                if last:
                    if f.read(1):
                        raise Damaged("data after the last chunk")
                    return
                index += 1
    except (InvalidToken, struct.error) as e:
        raise Damaged(repr(e)) from None


def read_file(uid, doc_id):
    return b"".join(iter_file(uid, doc_id))


def copy_file(uid, doc_id, out):
    """Writes the decrypted file to the open file `out`."""
    for chunk in iter_file(uid, doc_id):
        out.write(chunk)


def remove_file(uid, doc_id):
    file_path(uid, doc_id).unlink(missing_ok=True)


def remove_user_files(uid):
    shutil.rmtree(db.DATA_DIR / "documents" / str(uid), ignore_errors=True)


# ---------- External tools

def run(args, timeout, cwd):
    """Runs a tool with a memory limit (prlimit) and a time limit. No shell: arguments are never parsed."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "LC_ALL": "C.UTF-8", "TMPDIR": str(cwd),
           "OMP_THREAD_LIMIT": "1"}  # tesseract: one thread, less memory
    if shutil.which("prlimit"):
        args = ["prlimit", f"--as={OCR_MEMORY_MB * 1024 * 1024}", "--", *args]
    return subprocess.run(args, cwd=cwd, env=env, capture_output=True, timeout=timeout, check=False)


def pdf_pages(path, cwd):
    """Number of pages. Refuses PDFs that need a password, or that poppler cannot read."""
    r = run(["pdfinfo", str(path)], 30, cwd)
    if r.returncode != 0:
        if b"password" in r.stderr.lower():
            raise Refused("This PDF is protected with a password. Remove the password, then upload it again.")
        log.info("pdfinfo refused an upload: %r", r.stderr[:200])
        raise Refused("Could not read this PDF. Check that the file is not damaged.")
    m = re.search(rb"^Pages:\s+(\d+)", r.stdout, re.M)
    if not m or int(m[1]) < 1:
        raise Refused("Could not read this PDF. Check that the file is not damaged.")
    return int(m[1])


def check_upload(path, cwd):
    """Returns (kind, pages) or raises Refused."""
    with open(path, "rb") as f:
        kind = kind_of(f.read(16))
    if not kind:
        raise Refused("This file type is not supported. Upload a PDF, JPEG, PNG or WebP file.")
    pages = pdf_pages(path, cwd) if kind == "pdf" else 1
    if pages > MAX_PAGES:
        raise Refused(f"This PDF has more than {MAX_PAGES} pages. Split it, then upload the parts.")
    return kind, pages


def _left(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise subprocess.TimeoutExpired("ocr", TOTAL_TIMEOUT)
    return min(PAGE_TIMEOUT, left)


def _tool(args, cwd, deadline):
    r = run(args, _left(deadline), cwd)
    if r.returncode != 0:
        raise ToolFailed(f"{args[0]} exit {r.returncode}: {r.stderr[:300]!r}")
    return r.stdout.decode("utf-8", "replace")


def _ocr(image, cwd, deadline):
    return _tool(["tesseract", str(image), "-", "-l", OCR_LANGS], cwd, deadline)


def extract(kind, src, cwd, deadline):
    """Returns (text, pages)."""
    if kind != "pdf":
        return _ocr(src, cwd, deadline).strip(), 1
    pages = pdf_pages(src, cwd)
    texts = []
    for n in range(1, pages + 1):
        text = _tool(["pdftotext", "-layout", "-f", str(n), "-l", str(n), str(src), "-"], cwd, deadline)
        if len(text.strip()) < MIN_PAGE_TEXT:  # a scanned page: render it, then OCR
            _tool(["pdftoppm", "-r", "300", "-png", "-singlefile", "-f", str(n), "-l", str(n), str(src),
                   str(cwd / "page")], cwd, deadline)
            ocr = _ocr(cwd / "page.png", cwd, deadline)
            (cwd / "page.png").unlink(missing_ok=True)
            text = ocr if len(ocr.strip()) > len(text.strip()) else text
        texts.append(text.strip())
    return "\n\n".join(t for t in texts if t), pages


def process(doc_id):
    """Reads the text of one document. On failure, the file stays: the user can retry or delete."""
    doc = db.get_document(None, doc_id)
    if not doc or doc["status"] != "processing":
        return
    _, ext = KINDS[doc["kind"]]
    work = db.TMP_DIR / tempfile.mkdtemp(prefix="doc-", dir=db.TMP_DIR)  # mode 0700
    try:
        src = work / f"doc.{ext}"
        fd = os.open(src, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as f:
            copy_file(doc["user_id"], doc_id, f)
        text, pages = extract(doc["kind"], src, work, time.monotonic() + TOTAL_TIMEOUT)
        found = suggest.suggest(text)
        db.update_document(doc_id, status="ready", error=None, pages=pages,
                           content=crypto.encrypt(text) if text else None,
                           suggested=crypto.encrypt(json.dumps(found)) if found else None)
    except subprocess.TimeoutExpired:
        log.warning("Document %s: reading the text took too long.", doc_id)
        db.update_document(doc_id, status="failed",
                           error="Reading the text took too long. Try again, or upload a smaller file.")
    except Refused as e:
        db.update_document(doc_id, status="failed", error=str(e))
    except Exception as e:
        log.warning("Document %s: text not read: %r", doc_id, e)
        db.update_document(doc_id, status="failed",
                           error="Could not read the text of this document. Try again, or delete it.")
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ---------- Background worker

_queue = queue.Queue()
_workers = []


def enqueue(doc_id):
    _queue.put(doc_id)


def _loop():
    while True:
        doc_id = _queue.get()
        try:
            if doc_id is None:
                return
            process(doc_id)
        except Exception:
            log.exception("Document worker error.")
        finally:
            _queue.task_done()


def requeue():
    """Documents still 'processing' (the server stopped while reading them) go back in the queue."""
    for doc_id in db.processing_documents():
        enqueue(doc_id)


def start():
    """Starts the workers, and reads the documents left from the last run."""
    requeue()
    for _ in range(OCR_WORKERS):
        t = threading.Thread(target=_loop, name="documents", daemon=True)
        t.start()
        _workers.append(t)
    for tool in ("pdfinfo", "pdftotext", "pdftoppm", "tesseract"):
        if not shutil.which(tool):
            log.warning("%s is missing. Documents uploaded to the diary cannot be read.", tool)


def stop():
    for _ in _workers:
        _queue.put(None)
    _workers.clear()


def wait_idle(timeout=300):
    """For tests: waits until the queue is empty."""
    end = time.monotonic() + timeout
    while _queue.unfinished_tasks and time.monotonic() < end:
        time.sleep(0.05)
    return not _queue.unfinished_tasks


# ---------- JSON for the app

def to_json(doc):
    """The same shape as a Paperless document, plus status. The id is a string ("d12"):
    it never collides with the numeric ids of Paperless."""
    did = f"d{doc['id']}"
    content = crypto.decrypt(doc["content"]) if doc["content"] else ""
    found = crypto.decrypt(doc["suggested"]) if doc["suggested"] else None
    edited = json.loads(doc["edited"])
    # Never offer again what the user set, or what is already saved.
    found = _without(json.loads(found) if found else None, edited, doc)
    return {
        "id": did, "source": "diary", "date": doc["date"], "title": doc["title"], "category": doc["category"],
        "correspondent": "", "content": content or "", "url": f"/api/documents/{did}/file",
        "status": doc["status"], "error": doc["error"], "pages": doc["pages"],
        "suggested": found, "createdAt": doc["created_at"], "edited": edited,
    }


def _without(found, edited, saved):
    """The suggestion without the fields the user set (edited) or that already have that value."""
    if not found:
        return None
    left = {k: v for k, v in found.items() if v and k not in edited and saved.get(k) != v}
    return left or None


# ---------- Paperless documents, with the user's own category, date and title
#
# Many users only tag documents "medical" in Paperless and set no document type. They can set
# one here. It is kept in the diary (kv "docMeta": {"<paperless id>": {category, date, title}})
# and never written to Paperless: the Paperless token is only used to read.

META_KEY = "docMeta"


def paperless_json(item, meta):
    over = meta.get(str(item["id"]), {})
    ptype = item.get("type")
    # Suggestions from the text. A category is suggested only when the Paperless type is not one
    # of ours (then mapped from the type name and the text). Fields the user set are left out below.
    suggested = suggest.suggest(item.get("content"))
    if ptype in suggest.CATEGORIES:
        if suggested:
            suggested.pop("category")
    elif suggested or ptype:
        suggested = suggested or {}
        suggested["category"] = suggest.suggest_category(f"{ptype or ''}\n{item.get('content') or ''}")
    return {
        "id": item["id"], "source": "paperless", "date": over.get("date") or item["date"],
        "title": over.get("title") or item["title"], "category": over.get("category") or ptype or "",
        "correspondent": item["correspondent"], "content": item["content"], "url": item["url"],
        "status": "ready", "error": None, "pages": None, "createdAt": item.get("added"),
        "suggested": _without(suggested, over, {"category": over.get("category") or ptype or "",
                                                 "date": over.get("date") or item["date"],
                                                 "title": over.get("title") or item["title"]}),
        "paperlessType": ptype, "edited": sorted(over),
    }


def list_all(uid, refresh=False):
    """The user's diary documents and Paperless documents, newest first. Paperless being down
    does not fail the list: the diary documents come back, with the Paperless error."""
    state = {"ok": True, "error": None}
    try:
        items = paperless.list_documents(uid, force=refresh)
    except paperless.PaperlessError as e:
        items, state = [], {"ok": False, "error": str(e)}
    # The user's corrections are never removed automatically: a document can leave the list for a
    # while (another tag, a Paperless problem) and come back. They are small.
    meta = db.get_kv(uid, META_KEY, {})
    docs = [to_json(d) for d in db.list_documents(uid)] + [paperless_json(i, meta) for i in items]
    docs.sort(key=lambda d: (d["date"] or "", d["createdAt"] or ""), reverse=True)
    return {"documents": docs, "paperless": state}


def diary_id(doc_id):
    """'d12' -> 12, else None."""
    m = re.fullmatch(r"d(\d{1,18})", doc_id)
    return int(m[1]) if m else None


def paperless_id(doc_id):
    return int(doc_id) if re.fullmatch(r"\d{1,18}", doc_id) else None


def get_paperless(uid, pid):
    """The Paperless document as the user sees it, or None."""
    item = next((i for i in paperless.list_documents(uid) if i["id"] == pid), None)
    return paperless_json(item, db.get_kv(uid, META_KEY, {})) if item else None


def set_paperless_meta(uid, pid, changes):
    """changes: {field: value}. None removes the user's value: the Paperless value shows again."""
    with db.transaction():
        meta = db.get_kv(uid, META_KEY, {})
        entry = meta.get(str(pid), {})
        for k, v in changes.items():
            if v is None:
                entry.pop(k, None)
            else:
                entry[k] = v
        if entry:
            meta[str(pid)] = entry
        else:
            meta.pop(str(pid), None)
        db.set_kv(uid, META_KEY, meta)


def title_from_name(filename):
    """'Bilan_sanguin-2025.pdf' -> 'Bilan sanguin 2025'. The user chose the name; it may stay."""
    stem = re.sub(r"\.[A-Za-z0-9]{1,5}$", "", (filename or "").strip())
    stem = " ".join(re.sub(r"[_\-]+", " ", stem).split())[:200]
    return stem or "Document"


def safe_name(title, kind):
    """A file name for downloads: letters, digits, spaces, dots, dashes. Never empty."""
    base = re.sub(r"[^A-Za-z0-9 ._-]+", "", title or "").strip(" .")[:80] or "document"
    return f"{base}.{KINDS[kind][1]}"


def today():
    """Today in the diary's time zone ($TZ): the default date of an upload."""
    return datetime.now(TZ).date().isoformat()
