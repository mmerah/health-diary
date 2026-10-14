"""Health Diary server: the JSON API for the web app, the shortcut endpoint, and the web app itself."""
import hmac
import logging
import os
import re
import secrets
import shutil
import tempfile
from pathlib import Path

from fastapi import Body, Depends, FastAPI, File, HTTPException, Query, Request, Response, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from . import auth, db, health, paperless

VERSION = os.environ.get("APP_VERSION", "dev")
WEB_DIR = Path(os.environ.get("WEB_DIR", Path(__file__).resolve().parents[2] / "web"))
DATE = r"^\d{4}-\d{2}-\d{2}$"
MEASUREMENT_TYPES = {"weight", "bp", "temp"}
DEFAULT_SETTINGS = {"lastSync": None, "redactWords": [], "excludedDocs": []}
API_DOCS = os.environ.get("ENABLE_API_DOCS", "").lower() == "true"

app = FastAPI(title="Health Diary", version=VERSION,
              docs_url="/api/docs" if API_DOCS else None, redoc_url=None,
              openapi_url="/api/openapi.json" if API_DOCS else None)
db.init()
log = logging.getLogger("uvicorn.error")

# On a new install, anyone who reaches the page first could create the admin account.
# The setup code is only in the container log, so only the person who runs the server can.
SETUP_CODE = os.environ.get("SETUP_CODE") or secrets.token_hex(4).upper()


@app.on_event("startup")
def show_setup_code():
    if db.count_users() == 0:
        log.warning("=" * 60)
        log.warning("No account yet. Open the app and use this setup code: %s", SETUP_CODE)
        log.warning("=" * 60)

User = Depends(auth.current_user)
Admin = Depends(auth.admin_user)

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; "
       "connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")


@app.middleware("http")
async def security(request: Request, call_next):
    # A page on another site must not be able to change data with your cookie. Browsers send
    # Sec-Fetch-Site and pages cannot fake it. SameSite=Lax cookies are the second barrier.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("sec-fetch-site") == "cross-site":
        return JSONResponse({"detail": "Request from another site refused."}, status_code=403)
    response = await call_next(request)
    if not (API_DOCS and request.url.path in ("/api/docs", "/api/openapi.json")):
        response.headers["Content-Security-Policy"] = CSP
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    token = getattr(request.state, "refresh_cookie", None)
    if token:
        auth.set_cookie(request, response, token)
    return response


def check_date(d):
    if not re.match(DATE, d or ""):
        raise HTTPException(400, "Use the date format YYYY-MM-DD.")
    return d


# ---------- Accounts

@app.get("/api/auth/status")
def auth_status(request: Request):
    try:
        user = auth.current_user(request)
    except HTTPException:
        user = None
    return {"setupNeeded": db.count_users() == 0, "user": user}


@app.post("/api/auth/setup")
def setup(request: Request, response: Response, body: dict = Body(...)):
    """Creates the first account (administrator). Works only while there is no account."""
    if db.count_users() > 0:
        raise HTTPException(409, "This install already has an account. Log in instead.")
    keys = (f"ip:{auth.client_ip(request)}",)
    auth.check_rate_limit(*keys)
    if not hmac.compare_digest(str(body.get("code") or "").strip().upper(), SETUP_CODE):
        auth.record_failure(*keys)
        raise HTTPException(403, "Wrong setup code. Find it in the server log: docker logs health-diary")
    username = auth.check_username(body.get("username"))
    auth.check_new_password(body.get("password"), username)
    user = db.create_user(username, auth.hash_password(body["password"]), is_admin=True)
    auth.start_session(request, response, user["id"])
    return user


@app.post("/api/auth/login")
def login(request: Request, response: Response, body: dict = Body(...)):
    username = (body.get("username") or "").strip()
    keys = (f"ip:{auth.client_ip(request)}", f"user:{username.lower()}")
    auth.check_rate_limit(*keys)
    user, stored = db.get_user_login(username)
    ok = auth.verify_password(body.get("password") or "", stored or auth._DUMMY)
    if not (user and ok):
        auth.record_failure(*keys)
        raise HTTPException(401, "Wrong username or password.")
    auth.clear_failures(*keys)
    auth.start_session(request, response, user["id"])
    return user


@app.post("/api/auth/logout", status_code=204)
def logout(request: Request, response: Response):
    auth.end_session(request, response)


@app.put("/api/me/password", status_code=204)
def change_password(request: Request, body: dict = Body(...), user=User):
    if not auth.verify_password(body.get("current") or "", db.get_password_hash(user["id"])):
        raise HTTPException(400, "The current password is wrong.")
    auth.check_new_password(body.get("new"), user["username"])
    db.set_password(user["id"], auth.hash_password(body["new"]))
    db.delete_sessions(user["id"], keep=request.state.session_hash)  # log out other devices


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
def put_paperless(body: dict = Body(...), user=User):
    paperless.save_config(user["id"], token=body.get("token"), tag=body.get("tag"))
    return paperless.public_config(user["id"])


# ---------- Users (administrator)

@app.get("/api/users")
def list_users(_=Admin):
    return db.list_users()


@app.post("/api/users", status_code=201)
def create_user(body: dict = Body(...), _=Admin):
    username = auth.check_username(body.get("username"))
    auth.check_new_password(body.get("password"), username)
    if db.get_user_login(username)[0]:
        raise HTTPException(409, "This username is already taken.")
    return db.create_user(username, auth.hash_password(body["password"]), bool(body.get("isAdmin")))


@app.put("/api/users/{uid}/password", status_code=204)
def reset_password(uid: int, body: dict = Body(...), _=Admin):
    target = db.get_user(uid) or {}
    if not target:
        raise HTTPException(404, "This user does not exist.")
    auth.check_new_password(body.get("password"), target["username"])
    db.set_password(uid, auth.hash_password(body["password"]))
    db.delete_sessions(uid)


@app.delete("/api/users/{uid}", status_code=204)
def delete_user(uid: int, me=Admin):
    if uid == me["id"]:
        raise HTTPException(400, "You cannot delete your own account.")
    if not db.delete_user(uid):
        raise HTTPException(404, "This user does not exist.")


# ---------- Profile and settings

@app.get("/api/profile")
def get_profile(user=User):
    return db.get_kv(user["id"], "profile", {})


@app.put("/api/profile", status_code=204)
def put_profile(profile: dict = Body(...), user=User):
    db.set_kv(user["id"], "profile", profile)


@app.get("/api/settings")
def get_settings(user=User):
    return {**DEFAULT_SETTINGS, **db.get_kv(user["id"], "settings", {})}


@app.put("/api/settings", status_code=204)
def put_settings(changes: dict = Body(...), user=User):
    """Merges the given keys into the settings."""
    db.set_kv(user["id"], "settings", {**get_settings(user), **changes})


# ---------- Days

@app.get("/api/days")
def list_days(date_from: str = Query("", alias="from"), date_to: str = Query("", alias="to"), user=User):
    return db.list_days(user["id"], check_date(date_from) if date_from else None, check_date(date_to) if date_to else None)


@app.get("/api/days/{date}")
def get_day(date: str, user=User):
    return db.get_day(user["id"], check_date(date))


@app.put("/api/days/{date}/log", status_code=204)
def put_log(date: str, log: dict = Body(...), user=User):
    db.save_day_part(user["id"], check_date(date), "log", log)


@app.put("/api/days/{date}/health", status_code=204)
def put_health(date: str, data: dict = Body(...), user=User):
    db.save_day_part(user["id"], check_date(date), "health", data)


# ---------- Measurements

@app.get("/api/measurements")
def list_measurements(type: str = "", user=User):
    return db.list_measurements(user["id"], type or None)


@app.post("/api/measurements", status_code=201)
def add_measurement(m: dict = Body(...), user=User):
    if m.get("type") not in MEASUREMENT_TYPES:
        raise HTTPException(400, f"type must be one of: {', '.join(sorted(MEASUREMENT_TYPES))}.")
    if m.get("value") in (None, ""):
        raise HTTPException(400, "value is missing.")
    return db.add_measurement(user["id"], m["type"], check_date(m.get("date")), m.get("time") or None, m["value"],
                              m.get("source") or "manual")


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
        raise HTTPException(502, str(e))


# ---------- Apple Health

@app.post("/api/ingest/health")
def ingest_health(payload: dict = Body(...), user=Depends(auth.ingest_user)):
    """Called by the iPhone shortcut with the user's shortcut key. See docs/shortcut.md."""
    try:
        return health.ingest_shortcut(user["id"], payload)
    except (ValueError, KeyError) as e:
        raise HTTPException(400, f"Could not read the data: {e}")


@app.post("/api/import/apple-health")
def import_apple_health(file: UploadFile = File(...), user=User):
    """Imports export.zip from the Health app (Profile picture > Export All Health Data)."""
    with tempfile.NamedTemporaryFile(dir=db.DATA_DIR, suffix=".upload") as tmp:
        shutil.copyfileobj(file.file, tmp)
        tmp.flush()
        try:
            return health.import_export(user["id"], tmp.name)
        except Exception as e:  # A broken upload must not crash the server.
            raise HTTPException(400, f"Could not import this file: {e}")


@app.get("/api/health")
def server_health():
    return {"ok": True, "version": VERSION}


# ---------- Web app

# index.html is written without <html>/<head>, so the same file also runs as the
# sample-data demo. Here it gets a full document, and config.js switches it to this server.
HEAD = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#EDF0EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0E1311" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icon.png">
<link rel="stylesheet" href="base.css">
<script src="config.js"></script>
"""


@app.get("/", response_class=HTMLResponse)
def index():
    page = (WEB_DIR / "index.html").read_text(encoding="utf-8")
    return HEAD + page.replace("<header", "</head><body>\n<header", 1) + "</body></html>"


@app.get("/config.js", response_class=PlainTextResponse)
def config_js():
    return PlainTextResponse("window.DIARY_CONFIG = { api: '/api' };\n", media_type="text/javascript")


app.mount("/", StaticFiles(directory=WEB_DIR), name="web")
