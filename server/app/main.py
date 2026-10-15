"""Health Diary server: the JSON API for the web app, the shortcut endpoint, and the web app itself."""
import asyncio
import logging
import os
import re
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
from fastapi.responses import JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles
from python_multipart.multipart import MultipartParser, parse_options_header

from . import auth, crypto, db, health, models, paperless

VERSION = os.environ.get("APP_VERSION", "dev")
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))
DATE = r"^\d{4}-\d{2}-\d{2}$"
DEFAULT_SETTINGS = {"lastSync": None, "redactWords": [], "excludedDocs": []}
API_DOCS = os.environ.get("ENABLE_API_DOCS", "").lower() == "true"
MAX_JSON = 1024 * 1024
MAX_IMPORT_MB = int(os.environ.get("MAX_IMPORT_MB", "2048"))
IMPORT_PATH = "/api/import/apple-health"
INGEST_PATH = "/api/ingest/health"
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
    paperless.encrypt_old_tokens()
    paperless.check_env()
    db.purge_sessions()
    fixed = os.environ.get("SETUP_CODE", "").strip()  # "SETUP_CODE=" in .env means: not set
    if fixed and not auth.strong_enough(fixed):
        log.error("SETUP_CODE is too weak. Use at least 16 letters or digits, or remove it to get a random code.")
        raise RuntimeError("SETUP_CODE is too weak.")
    SETUP_CODE = fixed or auth.new_setup_code()
    show_setup_code()
    task = asyncio.create_task(purge_sessions_hourly())
    yield
    task.cancel()


app = FastAPI(title="Health Diary", version=VERSION, lifespan=lifespan,
              docs_url="/api/docs" if API_DOCS else None, redoc_url=None,
              openapi_url="/api/openapi.json" if API_DOCS else None)

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

@app.middleware("http")
async def security(request: Request, call_next):
    # A page on another site must not be able to change data with your cookie. Browsers send
    # Sec-Fetch-Site and pages cannot fake it. Without it (older browsers), the request must carry
    # the X-Requested-With header that the app sends: a cross-site form cannot add it.
    # SameSite=Lax cookies are a second barrier. The shortcut uses a key, not a cookie.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path != INGEST_PATH:
        site = request.headers.get("sec-fetch-site")
        allowed = site in ("same-origin", "none") if site else \
            request.headers.get("x-requested-with") == "health-diary"
        if not allowed:
            return JSONResponse({"detail": "Request refused. It did not come from this app."}, status_code=403)
    response = await call_next(request)
    if not (API_DOCS and request.url.path in ("/api/docs", "/api/openapi.json")):
        response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    ctype = response.headers.get("content-type", "")
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    elif ctype.startswith(("text/html", "text/javascript", "application/javascript", "text/css")):
        # Check with the server each time (ETag makes that cheap). After an upgrade,
        # the browser never runs old JavaScript with new HTML.
        response.headers["Cache-Control"] = "no-cache"
    return response


class BodyLimit:
    """Refuses bodies over the limit: by Content-Length first, then by counting what arrives
    (a client can send without Content-Length, or lie)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        big = scope["path"] == IMPORT_PATH
        limit = MAX_IMPORT_MB * 1024 * 1024 if big else MAX_JSON
        message = (f"The file is too large. The limit is {MAX_IMPORT_MB} MB." if big
                   else "The request is too large.")
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


app.add_middleware(BodyLimit)


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
    paperless.save_config(user["id"], token=body.token, tag=body.tag)
    return paperless.public_config(user["id"])


@app.get("/api/me/export")
def export_me(user=User):
    """Everything the server holds about you, as one JSON file. Secrets (tokens, keys) are left out."""
    uid = user["id"]
    data = {
        "format": "health-diary-export",
        "version": 1,
        "exportedAt": datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "user": {"username": user["username"], "isAdmin": user["isAdmin"], "createdAt": user["createdAt"]},
        "profile": db.get_kv(uid, "profile", {}),
        "settings": get_settings(user),
        "paperless": {"tag": paperless.user_config(uid)[1]},
        "days": db.list_days(uid),
        "measurements": db.list_measurements(uid),
    }
    name = f"health-diary-{user['username']}-{Date.today().isoformat()}.json"
    ascii_name = name.encode("ascii", "replace").decode().replace("?", "_")
    return JSONResponse(data, headers={
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
def reset_password(uid: int, body: models.Password, me=Admin):
    target = _target(uid)
    auth.check_new_password(body.password, target["username"])
    # The user sees this at the next login, so a reset is never hidden from them.
    notice = (f"An administrator ({me['username']}) reset your password on {Date.today().isoformat()}. "
              "If you did not ask for this, talk to them.")
    db.set_password(uid, auth.hash_password(body.password), notice=notice if uid != me["id"] else None)
    db.delete_sessions(uid)
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
    log.info("Admin %s deleted user %s and all their data.", me["username"], target["username"])


# ---------- Profile and settings

def base_version(value: str | None = Header(None, alias="X-Base-Version")):
    """The version the device started from. Without it, a save is not checked (older clients)."""
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
    value = m.model_dump()["value"]
    return db.add_measurement(user["id"], m.type, m.date, m.time or None, value, "manual")


@app.delete("/api/measurements/{mid}", status_code=204)
def delete_measurement(mid: int, user=User):
    if not db.delete_measurement(user["id"], mid):
        raise HTTPException(404, "This measurement does not exist.")


# ---------- Documents (Paperless)

@app.get("/api/documents")
def list_documents(refresh: bool = False, user=User):
    try:
        return paperless.list_documents(user["id"], force=refresh)
    except paperless.PaperlessError as e:
        raise HTTPException(502, str(e)) from None


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
    Nothing is kept in memory except the part headers."""
    MAX_HEADER = 8192

    def __init__(self, fh, boundary):
        self.fh, self.found, self.in_file = fh, False, False
        self.headers, self.field, self.value = {}, b"", b""
        self.parser = MultipartParser(boundary, {
            "on_part_begin": self._begin, "on_header_field": self._field, "on_header_value": self._value,
            "on_header_end": self._header_end, "on_headers_finished": self._headers_done,
            "on_part_data": self._data, "on_part_end": self._end})

    def _begin(self):
        self.headers, self.in_file = {}, False

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
        self.in_file = params.get(b"name") == b"file"
        self.found |= self.in_file

    def _data(self, data, start, end):
        if self.in_file:
            self.fh.write(data[start:end])

    def _end(self):
        self.in_file = False


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
    ctype, params = parse_options_header(request.headers.get("content-type", ""))
    if ctype != b"multipart/form-data" or not params.get(b"boundary"):
        raise HTTPException(400, "Send the file as a form upload, in a field named file.")
    fd, path = tempfile.mkstemp(dir=db.TMP_DIR, suffix=".upload")
    try:
        with os.fdopen(fd, "wb") as fh:
            upload = _Upload(fh, params[b"boundary"])
            try:
                async for chunk in request.stream():
                    upload.parser.write(chunk)
                upload.parser.finalize()
            except ValueError as e:
                log.warning("Upload not read: %r", e)
                raise HTTPException(400, "The upload is broken. Try again.") from None
        if not upload.found:
            raise HTTPException(400, "No file in the upload. Send it in a field named file.")
        return await run_in_threadpool(_import, user["id"], path)
    finally:
        os.unlink(path)


@app.get("/api/health")
def server_health():
    return {"ok": True, "version": VERSION}


# ---------- Web app

# Registered before the static files: web/config.js holds the demo settings; this one wins.
@app.get("/config.js", response_class=PlainTextResponse)
def config_js():
    return PlainTextResponse("window.DIARY_CONFIG = { api: '/api' };\n", media_type="text/javascript")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
