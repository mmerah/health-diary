"""Health Diary server: the JSON API for the web app, the shortcut endpoint, and the web app itself."""
import asyncio
import itertools
import json
import logging
import os
import re
import shutil
import sqlite3
import tempfile
import zipfile
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from datetime import date as Date
from pathlib import Path
from urllib.parse import quote
from xml.etree.ElementTree import ParseError

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from python_multipart.multipart import MultipartParser, parse_options_header
from starlette.background import BackgroundTask
from starlette.datastructures import Headers, MutableHeaders

from . import auth, catalog, crypto, db, documents, health, models, paperless

VERSION = os.environ.get("APP_VERSION", "dev")
COMMIT = os.environ.get("APP_COMMIT", "")
BUILT = os.environ.get("APP_BUILT", "")
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))
DATE = r"^\d{4}-\d{2}-\d{2}$"
DEFAULT_SETTINGS = {"lastSync": None, "redactWords": [], "excludedDocs": []}
MAX_JSON = 1024 * 1024
IMPORT_PATH = "/api/import/apple-health"
INGEST_PATH = "/api/ingest/health"
DOCUMENTS_PATH = "/api/documents"
log = logging.getLogger("uvicorn.error")

# On a new install, anyone who reaches the page first could create the admin account.
# The setup code is only in the container log, so only the person who runs the server can.
SETUP_CODE = None


def show_setup_code():
    if db.count_users() == 0:
        log.warning("=" * 60)
        log.warning("No account yet. Open the app and use this setup code: %s", SETUP_CODE)
        log.warning("=" * 60)


async def purge_sessions_hourly():
    while True:
        await asyncio.sleep(3600)
        try:
            await run_in_threadpool(db.purge_sessions)
        except Exception:
            log.exception("Could not delete expired sessions.")


@asynccontextmanager
async def lifespan(_app):
    global SETUP_CODE
    if not os.environ.get("TZ"):
        log.warning("TZ is not set. Days start at midnight UTC. Set TZ in .env, for example TZ=Europe/Paris.")
    db.init()
    crypto.init()
    db.purge_sessions()
    SETUP_CODE = auth.new_setup_code()
    show_setup_code()
    documents.start()
    task = asyncio.create_task(purge_sessions_hourly())
    yield
    task.cancel()
    documents.stop()


app = FastAPI(title="Health Diary", version=VERSION, lifespan=lifespan,
              docs_url=None, redoc_url=None, openapi_url=None)

User = Depends(auth.current_user)
Admin = Depends(auth.admin_user)

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; "
       "form-action 'self'")


# ---------- Errors: plain messages for the user, details only in the server log

@app.exception_handler(RequestValidationError)
async def invalid_body(_request, exc):
    fields = []
    for e in exc.errors():
        name = ".".join(str(x) for x in e.get("loc", ()) if x not in ("body", "query", "path"))
        if name and name not in fields:
            fields.append(name)
    detail = "Some values are not valid" + (f": {', '.join(fields[:5])}." if fields else ".")
    return JSONResponse({"detail": detail}, status_code=400)


@app.exception_handler(Exception)
async def server_error(request, exc):
    log.error("Error on %s %s", request.method, request.url.path, exc_info=exc)
    return JSONResponse({"detail": "Something went wrong on the server. Try again later."}, status_code=500)


# ---------- Middleware

class Security:
    """Security headers on every answer, and the check against requests from other sites.
    Plain ASGI (not @app.middleware): errors while the body is read reach the app's handlers
    as they are, not wrapped in an exception group."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path, method = scope["path"], scope["method"]
        # A page on another site must not be able to change data with your cookie. Browsers send
        # Sec-Fetch-Site and pages cannot fake it. Without it (older browsers), the request must carry
        # the X-Requested-With header that the app sends: a cross-site form cannot add it.
        # SameSite=Lax cookies are a second barrier. The shortcut uses a key, not a cookie.
        if method not in ("GET", "HEAD", "OPTIONS") and path != INGEST_PATH:
            headers = Headers(scope=scope)
            site = headers.get("sec-fetch-site")
            allowed = site in ("same-origin", "none") if site else headers.get("x-requested-with") == "health-diary"
            if not allowed:
                response = JSONResponse({"detail": "Request refused. It did not come from this app."}, status_code=403)
                return await response(scope, receive, send)

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                # A route may set a stricter policy (stored document files: sandbox).
                h.setdefault("Content-Security-Policy", CSP)
                h["X-Content-Type-Options"] = "nosniff"
                h["Referrer-Policy"] = "no-referrer"
                h.setdefault("X-Frame-Options", "DENY")
                h["Cross-Origin-Opener-Policy"] = "same-origin"
                h["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
                if path.startswith("/api/"):
                    h["Cache-Control"] = "no-store"
                elif h.get("content-type", "").startswith(("text/html", "text/javascript", "application/javascript",
                                                            "text/css")):
                    # Check with the server each time (ETag makes that cheap). After an upgrade,
                    # the browser never runs old JavaScript with new HTML.
                    h["Cache-Control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_with_headers)


class BodyLimit:
    """Refuses bodies over the limit: by Content-Length first, then by counting what arrives
    (a client can send without Content-Length, or lie)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        if scope["path"] == IMPORT_PATH:
            # No size limit: an Apple Health export can be many GB. The free disk space is checked
            # instead (receive_upload).
            return await self.app(scope, receive, send)
        if scope["path"] == DOCUMENTS_PATH and scope["method"] == "POST":
            # Multipart adds a few hundred bytes around the file, and the optional fields.
            limit = documents.MAX_DOC_MB * 1024 * 1024 + 64 * 1024
            message = f"The file is too large. The limit is {documents.MAX_DOC_MB} MB."
        else:
            limit, message = MAX_JSON, "The request is too large."
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and (not length.isdigit() or int(length) > limit):
            return await JSONResponse({"detail": message}, status_code=413)(scope, receive, send)
        received, exceeded, sent = 0, False, False

        async def counted():
            nonlocal received, exceeded
            msg = await receive()
            if msg["type"] == "http.request":
                received += len(msg.get("body", b""))
                if received > limit:
                    exceeded = True
                    raise HTTPException(413, message)
            return msg

        async def guarded_send(msg):
            # FastAPI turns an error while it reads the body into a 400. Send the 413 instead.
            nonlocal sent
            if not exceeded:
                return await send(msg)
            if not sent:
                sent = True
                await JSONResponse({"detail": message}, status_code=413)(scope, receive, send)

        await self.app(scope, counted, guarded_send)


app.add_middleware(Security)
app.add_middleware(BodyLimit)  # added last: runs first


def check_date(d):
    if not d or not re.match(DATE, d):
        raise HTTPException(400, "Use the date format YYYY-MM-DD.")
    try:
        Date.fromisoformat(d)
    except ValueError:
        raise HTTPException(400, "This date does not exist.") from None
    return d


def check_password_or_429(request, user, password, message):
    """Checks the password of a logged-in user. Wrong guesses count like failed logins."""
    pair = (auth.LOGIN_USER, f"{auth.client_ip(request)}|{user['username'].lower()}")
    auth.attempt(pair)
    if not auth.verify_password(password, db.get_password_hash(user["id"])):
        raise HTTPException(400, message)
    auth.succeeded(pair)


# ---------- Accounts

@app.get("/api/auth/status")
def auth_status(request: Request, response: Response):
    return {"setupNeeded": db.count_users() == 0, "user": auth.session_user(request, response)}


@app.post("/api/auth/setup")
def setup(request: Request, response: Response, body: models.Setup):
    """Creates the first account (administrator). Works only while there is no account."""
    if db.count_users() > 0:
        raise HTTPException(409, "This install already has an account. Log in instead.")
    pair = (auth.SETUP_IP, auth.client_ip(request))
    auth.attempt(pair)
    if not auth.same_setup_code(body.code, SETUP_CODE):
        raise HTTPException(403, "Wrong setup code. Find it in the server log: docker logs health-diary")
    auth.succeeded(pair)
    username = auth.check_username(body.username)
    auth.check_new_password(body.password, username)
    # The count is checked again in the same transaction as the insert: two setups at once make one account.
    user = db.create_user(username, auth.hash_password(body.password), is_admin=True, only_if_empty=True)
    if not user:
        raise HTTPException(409, "This install already has an account. Log in instead.")
    log.info("First account created: %s (administrator).", username)
    auth.start_session(request, response, user["id"])
    return user


@app.post("/api/auth/login")
def login(request: Request, response: Response, body: models.Login):
    username = body.username.strip()
    ip = auth.client_ip(request)
    pairs = ((auth.LOGIN_IP, ip), (auth.LOGIN_USER, f"{ip}|{username.lower()}"))
    auth.attempt(*pairs)  # counted before the check, so parallel guesses cannot all pass
    user = auth.authenticate(username, body.password)
    if not user:
        raise HTTPException(401, "Wrong username or password.")
    auth.succeeded(*pairs)
    auth.start_session(request, response, user["id"])
    return user


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response):
    auth.end_session(request, response)


@app.put("/api/me/password", status_code=204)
def change_password(request: Request, body: models.PasswordChange, user=User):
    check_password_or_429(request, user, body.current, "The current password is wrong.")
    auth.check_new_password(body.new, user["username"])
    db.set_password(user["id"], auth.hash_password(body.new))
    db.delete_sessions(user["id"], keep=request.state.session_hash)  # log out other devices


@app.post("/api/me/notice/dismiss", status_code=204)
def dismiss_notice(user=User):
    db.clear_notice(user["id"])


@app.post("/api/me/ingest-token")
def create_ingest_token(user=User):
    """A new key for the iPhone shortcut. It is shown once; only its hash is stored."""
    token = auth.new_token()
    db.set_ingest_token(user["id"], auth.token_hash(token))
    return {"token": token}


@app.delete("/api/me/ingest-token", status_code=204)
def revoke_ingest_token(user=User):
    db.set_ingest_token(user["id"], None)


@app.get("/api/me/paperless")
def get_paperless(user=User):
    return paperless.public_config(user["id"])


@app.put("/api/me/paperless")
def put_paperless(body: models.PaperlessSettings, user=User):
    paperless.save_config(user["id"], token=body.token, tags=body.tags)
    return paperless.public_config(user["id"])


@app.get("/api/me/paperless/tags")
def paperless_tags(user=User):
    """All tags in your Paperless, with their number of documents, to choose from."""
    try:
        return paperless.tag_list(user["id"])
    except paperless.NotSetUp as e:
        raise HTTPException(400, str(e)) from None
    except paperless.PaperlessError as e:
        raise HTTPException(502, str(e)) from None


def _build_export(user, path):
    uid = user["id"]
    docs = db.list_documents(uid)
    files = {d["id"]: f"documents/d{d['id']}-{documents.safe_name(d['title'], d['kind'])}" for d in docs}
    data = {
        "format": "health-diary-export",
        "version": 2,  # 2: a zip with the documents; data.json as in version 1, plus "documents"
        "exportedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": {"username": user["username"], "isAdmin": user["isAdmin"], "createdAt": user["createdAt"]},
        "profile": db.get_kv(uid, "profile", {}),
        "settings": get_settings(user),
        "catalog": catalog.get(uid),
        "paperless": {"tags": paperless.user_config(uid)[1],
                      "documentSettings": db.get_kv(uid, documents.META_KEY, {})},
        "days": db.list_days(uid),
        "measurements": db.list_measurements(uid),
        "documents": [{**documents.to_json(d), "file": files[d["id"]]} for d in docs],
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("data.json", json.dumps(data, ensure_ascii=False, indent=1))
        for d in docs:
            try:
                with z.open(zipfile.ZipInfo(files[d["id"]]), "w", force_zip64=True) as out:  # stored, not packed
                    documents.copy_file(uid, d["id"], out)
            except (OSError, documents.Damaged) as e:
                log.warning("Export: document d%s not readable: %r", d["id"], e)


@app.get("/api/me/export")
async def export_me(user=User):
    """Everything the server holds about you, as a zip: data.json and your documents (decrypted).
    Secrets (tokens, keys) are left out. Paperless documents stay in Paperless."""
    fd, path = tempfile.mkstemp(dir=db.TMP_DIR, suffix=".zip")
    os.close(fd)
    try:
        await run_in_threadpool(_build_export, user, path)
    except BaseException:
        os.unlink(path)
        raise
    name = f"health-diary-{user['username']}-{Date.today().isoformat()}.zip"
    ascii_name = name.encode("ascii", "replace").decode().replace("?", "_")
    return FileResponse(path, media_type="application/zip", background=BackgroundTask(os.unlink, path), headers={
        "Content-Disposition": f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(name)}"})


@app.delete("/api/me", status_code=204)
def delete_me(request: Request, response: Response, body: models.Password, user=User):
    """Deletes your account and all your data. Needs your password."""
    check_password_or_429(request, user, body.password, "The password is wrong.")
    try:
        db.delete_user(user["id"], allow_sole_user=True)
    except db.LastAdmin:
        raise HTTPException(409, "You are the last administrator. Make another user an administrator first.") from None
    paperless.forget(user["id"])
    documents.remove_user_files(user["id"])
    response.delete_cookie(auth.COOKIE, path="/")
    log.info("User %s deleted their own account.", user["username"])
    show_setup_code()


# ---------- Users (administrator)

@app.get("/api/users")
def list_users(_=Admin):
    return db.list_users()


@app.post("/api/users", status_code=201)
def create_user(body: models.NewUser, me=Admin):
    username = auth.check_username(body.username)
    auth.check_new_password(body.password, username)
    try:
        user = db.create_user(username, auth.hash_password(body.password), body.isAdmin)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "This username is already taken.") from None
    log.info("Admin %s created user %s%s.", me["username"], username, " (administrator)" if body.isAdmin else "")
    return user


def _target(uid):
    user = db.get_user(uid)
    if not user:
        raise HTTPException(404, "This user does not exist.")
    return user


@app.put("/api/users/{uid}/password", status_code=204)
def reset_password(request: Request, uid: int, body: models.Password, me=Admin):
    target = _target(uid)
    auth.check_new_password(body.password, target["username"])
    # The user sees this at the next login, so a reset is never hidden from them.
    notice = (f"An administrator ({me['username']}) reset your password on {Date.today().isoformat()}. "
              "If you did not ask for this, talk to them.")
    db.set_password(uid, auth.hash_password(body.password), notice=notice if uid != me["id"] else None)
    # Logs the user out everywhere. An administrator who sets their own password stays logged in
    # here, like with Change password.
    db.delete_sessions(uid, keep=request.state.session_hash if uid == me["id"] else None)
    log.info("Admin %s reset the password of %s.", me["username"], target["username"])


@app.put("/api/users/{uid}/admin")
def set_admin(uid: int, body: models.AdminFlag, me=Admin):
    target = _target(uid)
    try:
        db.set_admin(uid, body.isAdmin)
    except db.LastAdmin:
        raise HTTPException(409, "This is the last administrator. Make another user an administrator first.") from None
    log.info("Admin %s %s administrator rights %s %s.", me["username"], "gave" if body.isAdmin else "removed",
             "to" if body.isAdmin else "from", target["username"])
    return db.get_user(uid)


@app.delete("/api/users/{uid}", status_code=204)
def delete_user(uid: int, me=Admin):
    if uid == me["id"]:
        raise HTTPException(400, "You cannot delete your own account here. Use Profile → Delete my account.")
    target = _target(uid)
    try:
        db.delete_user(uid)
    except db.LastAdmin:
        raise HTTPException(409, "This is the last administrator. Make another user an administrator first.") from None
    paperless.forget(uid)
    documents.remove_user_files(uid)
    log.info("Admin %s deleted user %s and all their data.", me["username"], target["username"])


# ---------- Profile and settings

def base_version(value: str | None = Header(None, alias="X-Base-Version")):
    """The version the device started from. Without it, a save is not checked."""
    if value is None:
        return None
    if not value.strip().isdigit():
        raise HTTPException(400, "X-Base-Version must be a whole number.")
    return int(value)


BaseVersion = Depends(base_version)


@app.get("/api/profile")
def get_profile(response: Response, user=User):
    profile, version = db.get_kv_version(user["id"], "profile", {})
    response.headers["X-Version"] = str(version)
    return profile


@app.put("/api/profile")
def put_profile(profile: models.Profile, base=BaseVersion, user=User):
    try:
        return {"version": db.set_kv(user["id"], "profile", profile.model_dump(exclude_unset=True), base)}
    except db.Conflict as e:
        return JSONResponse({"detail": "Your profile was changed on another device.",
                             "profile": e.value if e.value is not None else {}, "version": e.version}, status_code=409)


@app.get("/api/settings")
def get_settings(user=User):
    stored = db.get_kv(user["id"], "settings", {})
    return {k: stored.get(k, v) for k, v in DEFAULT_SETTINGS.items()}


@app.put("/api/settings", status_code=204)
def put_settings(changes: models.Settings, user=User):
    """Merges the given keys into the settings. lastSync is set by the server only."""
    db.update_kv(user["id"], "settings", changes.model_dump(exclude_unset=True, exclude_none=True, exclude={"lastSync"}))


# ---------- The user's own catalog

@app.get("/api/catalog")
def get_catalog(user=User):
    """The user's own symptoms, document types, measurements and counters, or null (defaults)."""
    return catalog.get(user["id"])


@app.put("/api/catalog")
def put_catalog(body: models.Catalog, user=User):
    return catalog.save(user["id"], body)


# ---------- Days

@app.get("/api/days")
def list_days(date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"), user=User):
    return db.list_days(user["id"], check_date(date_from) if date_from else None, check_date(date_to) if date_to else None)


@app.get("/api/days/{date}")
def get_day(date: str, user=User):
    return db.get_day(user["id"], check_date(date))


@app.put("/api/days/{date}/log")
def put_log(date: str, log_: models.DayLog, base=BaseVersion, user=User):
    try:
        version = db.save_log(user["id"], check_date(date), log_.model_dump(by_alias=True, exclude_unset=True), base)
    except db.Conflict as e:
        return JSONResponse({"detail": "This day was changed on another device.", "log": e.value,
                             "logVersion": e.version}, status_code=409)
    return {"logVersion": version}


@app.put("/api/days/{date}/health", status_code=204)
def put_health(date: str, data: models.DayHealth, user=User):
    db.save_day_part(user["id"], check_date(date), "health", data.model_dump(exclude_unset=True))


# ---------- Measurements

@app.get("/api/measurements")
def list_measurements(mtype: str = Query("", alias="type"), date_from: str = Query("", alias="from"),
                      date_to: str = Query("", alias="to"), user=User):
    return db.list_measurements(user["id"], mtype or None, check_date(date_from) if date_from else None,
                                check_date(date_to) if date_to else None)


@app.post("/api/measurements", status_code=201)
def add_measurement(m: models.MeasurementIn, user=User):
    if isinstance(m, models.CustomIn):
        own = catalog.measurement(user["id"], m.type)
        if not own:
            raise HTTPException(400, "This measurement is not in your list.")
        if not own["min"] <= m.value <= own["max"]:
            raise HTTPException(400, f"Use a value from {own['min']:g} to {own['max']:g} for {own['name']}.")
    value = m.model_dump()["value"]
    return db.add_measurement(user["id"], m.type, m.date, m.time or None, value, "manual")


@app.delete("/api/measurements/{mid}", status_code=204)
def delete_measurement(mid: int, user=User):
    if not db.delete_measurement(user["id"], mid):
        raise HTTPException(404, "This measurement does not exist.")


# ---------- Documents (Paperless)

@app.get(DOCUMENTS_PATH)
def list_documents(refresh: bool = False, user=User):
    """Diary documents and Paperless documents together. A Paperless error does not fail the list."""
    return documents.list_all(user["id"], refresh)


def check_doc_type(uid, category):
    if category and category not in catalog.doc_types(uid):
        raise HTTPException(400, "This document type is not in your list. Add it in Profile first.")


def _upload_document(uid, path, fields, work):
    filename = fields.pop("filename", "")
    try:
        meta = models.DocumentUpload.model_validate({k: v for k, v in fields.items() if v})
    except ValidationError as e:
        names = ", ".join(sorted({str(err["loc"][0]) for err in e.errors() if err.get("loc")}))
        raise HTTPException(400, f"Some values are not valid: {names}.") from None
    check_doc_type(uid, meta.category)
    try:
        kind, pages = documents.check_upload(path, work)
    except documents.Refused as e:
        raise HTTPException(400, str(e)) from None
    title = meta.title or documents.title_from_name(filename)
    # Values the user gave at upload count as set by the user: no suggestion replaces them.
    edited = [k for k in ("date", "title", "category") if getattr(meta, k)]
    doc = db.add_document(uid, kind, meta.date or documents.today(), title, meta.category or "", pages,
                          os.path.getsize(path), edited)
    try:
        documents.store_file(uid, doc["id"], path)
    except Exception:
        db.delete_document(uid, doc["id"])
        raise
    documents.enqueue(doc["id"])
    return documents.to_json(doc)


@app.post(DOCUMENTS_PATH, status_code=201)
async def upload_document(request: Request, user=User):
    """Keeps a document (PDF, JPEG, PNG or WebP) in the diary. The text is read in the background.
    The login is checked before the body is read, so an anonymous upload writes nothing."""
    auth.attempt((auth.DOC_UPLOAD, user["id"]), message="Too many uploads.")
    work = Path(tempfile.mkdtemp(prefix="upload-", dir=db.TMP_DIR))
    try:
        path = work / "upload.bin"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fields = await receive_upload(request, fh, ("date", "title", "category", "filename"))
        return await run_in_threadpool(_upload_document, user["id"], path, fields, work)
    finally:
        shutil.rmtree(work, ignore_errors=True)


def _diary_doc(uid, doc_id):
    did = documents.diary_id(doc_id)
    doc = db.get_document(uid, did) if did is not None else None
    if not doc:  # also when it belongs to another user: same answer
        raise HTTPException(404, "This document does not exist.")
    return doc


def _paperless_doc(uid, pid):
    try:
        doc = documents.get_paperless(uid, pid)
    except paperless.PaperlessError as e:
        raise HTTPException(502, str(e)) from None
    if not doc:
        raise HTTPException(404, "This document does not exist.")
    return doc


@app.get(DOCUMENTS_PATH + "/{doc_id}")
def get_document(doc_id: str, user=User):
    pid = documents.paperless_id(doc_id)
    if pid is not None:
        return _paperless_doc(user["id"], pid)
    return documents.to_json(_diary_doc(user["id"], doc_id))


@app.patch(DOCUMENTS_PATH + "/{doc_id}")
def patch_document(doc_id: str, body: models.DocumentPatch, user=User):
    """Changes date, title or category. For Paperless documents, the change stays in the diary
    (Paperless is never changed); null gives back the Paperless value."""
    changes = {k: getattr(body, k) for k in body.model_fields_set}
    check_doc_type(user["id"], changes.get("category"))
    pid = documents.paperless_id(doc_id)
    if pid is not None:
        _paperless_doc(user["id"], pid)
        documents.set_paperless_meta(user["id"], pid, changes)
        return _paperless_doc(user["id"], pid)
    doc = _diary_doc(user["id"], doc_id)
    if any(changes.get(k, "") is None for k in ("date", "title")):
        raise HTTPException(400, "A document needs a date and a title.")
    edited = set(json.loads(doc["edited"]))
    if "category" in changes and changes["category"] is None:
        changes["category"] = ""  # not set: the suggestion shows again
        edited.discard("category")
        edited |= set(changes) - {"category"}
    else:
        edited |= set(changes)
    if changes:
        db.update_document(doc["id"], **changes, edited=json.dumps(sorted(edited)))
    return documents.to_json(db.get_document(user["id"], doc["id"]))


@app.delete(DOCUMENTS_PATH + "/{doc_id}", status_code=204)
def delete_document(doc_id: str, user=User):
    if documents.paperless_id(doc_id) is not None:
        raise HTTPException(400, "Delete it in Paperless.")
    doc = _diary_doc(user["id"], doc_id)
    with db.transaction():
        db.delete_document(user["id"], doc["id"])
        settings = db.get_kv(user["id"], "settings", {})
        if doc_id in (settings.get("excludedDocs") or []):
            settings["excludedDocs"] = [x for x in settings["excludedDocs"] if x != doc_id]
            db.set_kv(user["id"], "settings", settings)
    documents.remove_file(user["id"], doc["id"])
    log.info("User %s deleted document %s.", user["username"], doc_id)


@app.post(DOCUMENTS_PATH + "/{doc_id}/retry")
def retry_document(doc_id: str, user=User):
    doc = _diary_doc(user["id"], doc_id)
    if doc["status"] == "processing":
        raise HTTPException(409, "This document is still being read.")
    db.update_document(doc["id"], status="processing", error=None)
    documents.enqueue(doc["id"])
    return documents.to_json(db.get_document(user["id"], doc["id"]))


@app.get(DOCUMENTS_PATH + "/{doc_id}/file")
def document_file(doc_id: str, user=User):
    """The original file. Images get a sandbox policy. PDFs get a strict policy without sandbox,
    because browsers do not show PDFs in a sandboxed page; PDF viewers do not run page scripts."""
    doc = _diary_doc(user["id"], doc_id)
    chunks = documents.iter_file(user["id"], doc["id"])
    try:
        first = next(chunks)  # fails here, before the answer starts, if the file cannot be read
    except (OSError, documents.Damaged) as e:
        log.warning("Document %s cannot be read: %r", doc_id, e)
        raise HTTPException(500, "This file cannot be read. Was DIARY_SECRET_KEY changed?") from None
    media, _ = documents.KINDS[doc["kind"]]
    name = documents.safe_name(doc["title"], doc["kind"])
    return StreamingResponse(itertools.chain([first], chunks), media_type=media, headers={
        "Content-Length": str(doc["size"]),
        "Content-Disposition": f'inline; filename="{name}"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": ("default-src 'none'; object-src 'self'; frame-ancestors 'self'" if media == "application/pdf"
                                    else "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; "
                                         "frame-ancestors 'self'"),
        "X-Frame-Options": "SAMEORIGIN",
    })


# ---------- Apple Health

@app.post(INGEST_PATH)
def ingest_health(payload: models.Ingest, user=Depends(auth.ingest_user)):
    """Called by the iPhone shortcut with the user's shortcut key. See docs/shortcut.md."""
    try:
        return health.ingest_shortcut(user["id"], payload.model_dump())
    except (ValueError, KeyError) as e:
        log.warning("Shortcut data from %s not read: %r", user["username"], e)
        raise HTTPException(400, "Could not read the data. Check the shortcut against docs/shortcut.md.") from None


class _Upload:
    """Receives a multipart body as a stream and writes the part named "file" to `fh`.
    Small text parts named in `fields` are kept (at most 1000 bytes each). Nothing else is
    kept in memory except the part headers."""
    MAX_HEADER, MAX_FIELD = 8192, 1000

    def __init__(self, fh, boundary, fields=()):
        self.fh, self.found, self.in_file = fh, False, False
        self.headers, self.field, self.value = {}, b"", b""
        self.wanted, self.fields, self.in_field = {f.encode() for f in fields}, {}, None
        self.wanted_names = set(fields)
        self.parser = MultipartParser(boundary, {
            "on_part_begin": self._begin, "on_header_field": self._field, "on_header_value": self._value,
            "on_header_end": self._header_end, "on_headers_finished": self._headers_done,
            "on_part_data": self._data, "on_part_end": self._end})

    def _begin(self):
        self.headers, self.in_file, self.in_field = {}, False, None

    def _grow(self, attr, data, start, end):
        setattr(self, attr, getattr(self, attr) + data[start:end])
        if len(self.field) + len(self.value) > self.MAX_HEADER:
            raise ValueError("part header too long")

    def _field(self, data, start, end):
        self._grow("field", data, start, end)

    def _value(self, data, start, end):
        self._grow("value", data, start, end)

    def _header_end(self):
        self.headers[self.field.lower()] = self.value
        self.field, self.value = b"", b""

    def _headers_done(self):
        _, params = parse_options_header(self.headers.get(b"content-disposition", b""))
        name = params.get(b"name")
        self.in_file = name == b"file"
        self.found |= self.in_file
        if self.in_file and params.get(b"filename") and "filename" in self.wanted_names:
            self.fields["filename"] = params[b"filename"][:200]
        if name in self.wanted:
            self.in_field = name.decode()
            self.fields[self.in_field] = b""

    def _data(self, data, start, end):
        if self.in_file:
            self.fh.write(data[start:end])
        elif self.in_field:
            self.fields[self.in_field] += data[start:end]
            if len(self.fields[self.in_field]) > self.MAX_FIELD:
                raise ValueError("form field too long")

    def _end(self):
        self.in_file, self.in_field = False, None


NO_ROOM = "There is not enough free disk space on the server for this file. Ask the administrator."


def check_room(size=0):
    """Refuses when `size` more bytes would leave less than the reserve free on the data disk."""
    if db.room() < size:
        raise HTTPException(507, NO_ROOM)


async def receive_upload(request, fh, fields=()):
    """Streams a multipart upload: the file to `fh`, and the small `fields`. Returns {field: text}.
    The free disk space is checked before, and every 16 MB while the file arrives."""
    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"multipart/form-data" or not params.get(b"boundary"):
        raise HTTPException(400, "Send the file as a form upload, in a field named file.")
    length = request.headers.get("content-length", "")
    check_room(int(length) if length.isdigit() else 0)
    upload = _Upload(fh, params[b"boundary"], fields)
    received, checked = 0, 0
    try:
        async for chunk in request.stream():
            upload.parser.write(chunk)
            received += len(chunk)
            if received - checked >= 16 * 1024 * 1024:
                checked = received
                check_room()
        upload.parser.finalize()
    except ValueError as e:
        log.warning("Upload not read: %r", e)
        raise HTTPException(400, "The upload is broken. Try again.") from None
    if not upload.found:
        raise HTTPException(400, "No file in the upload. Send it in a field named file.")
    return {k: v.decode("utf-8", "replace").strip() for k, v in upload.fields.items()}


def _import(uid, path):
    try:
        return health.import_export(uid, path)
    except health.ImportRefused as e:
        raise HTTPException(400, str(e)) from None
    except (ValueError, zipfile.BadZipFile, ParseError, EOFError, OSError) as e:
        log.warning("Apple Health import failed: %r", e)
        raise HTTPException(400, "Could not read this file. Upload the export.zip from the Health app.") from None


@app.post(IMPORT_PATH)
async def import_apple_health(request: Request, user=User):
    """Imports export.zip from the Health app (Profile picture > Export All Health Data).
    The login is checked before the body is read, so an anonymous upload writes nothing."""
    fd, path = tempfile.mkstemp(dir=db.TMP_DIR, suffix=".upload")
    try:
        with os.fdopen(fd, "wb") as fh:
            await receive_upload(request, fh)
        return await run_in_threadpool(_import, user["id"], path)
    finally:
        os.unlink(path)


@app.get("/api/health")
def server_health():
    """Public: the app version, for the About card and for bug reports."""
    return {"ok": True, "version": VERSION, "commit": COMMIT, "built": BUILT}


# ---------- Web app

# Registered before the static files: web/config.js holds the demo settings; this one wins.
@app.get("/config.js", response_class=PlainTextResponse)
def config_js():
    return PlainTextResponse("window.DIARY_CONFIG = { api: '/api' };\n", media_type="text/javascript")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
