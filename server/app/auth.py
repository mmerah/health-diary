"""Accounts: password hashing, sessions, shortcut keys and protection against password guessing."""
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, Request, Response

from . import db

COOKIE = "hd_session"
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
# "auto": Secure cookie when the request came over HTTPS (Tailscale, reverse proxy). "true"/"false" force it.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").lower()
MIN_PASSWORD = 10

# scrypt with N=2^15, r=8: about 32 MB of memory and ~0.1 s for each check.
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}


def hash_password(password):
    salt = os.urandom(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, maxmem=64 * 1024 * 1024, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${dk.hex()}"


def verify_password(password, stored):
    try:
        _, n, r, p, salt, expected = stored.split("$")
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
                            maxmem=64 * 1024 * 1024, dklen=32)
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(dk.hex(), expected)


# Checked when the username does not exist, so the answer takes the same time.
_DUMMY = hash_password(secrets.token_hex(8))


def check_new_password(password, username=""):
    if len(password or "") < MIN_PASSWORD:
        raise HTTPException(400, f"Use at least {MIN_PASSWORD} characters for the password.")
    if username and password.lower() == username.lower():
        raise HTTPException(400, "The password must not be the same as the username.")


def check_username(username):
    u = (username or "").strip()
    if not (2 <= len(u) <= 40) or not all(c.isalnum() or c in "._-" for c in u):
        raise HTTPException(400, "Use 2 to 40 letters, digits, dots, dashes or underscores for the username.")
    return u


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def new_token():
    return secrets.token_urlsafe(32)


# ---------- Password guessing: after 5 failures in 15 minutes, wait.

WINDOW, MAX_FAILURES = 15 * 60, 5
_failures = defaultdict(deque)


def _recent(key):
    q, now = _failures[key], time.monotonic()
    while q and now - q[0] > WINDOW:
        q.popleft()
    return q


def check_rate_limit(*keys):
    for key in keys:
        q = _recent(key)
        if len(q) >= MAX_FAILURES:
            wait = int(WINDOW - (time.monotonic() - q[0])) + 1
            raise HTTPException(429, f"Too many failed attempts. Try again in {wait // 60 + 1} minutes.",
                                headers={"Retry-After": str(wait)})


def record_failure(*keys):
    for key in keys:
        _recent(key).append(time.monotonic())


def clear_failures(*keys):
    for key in keys:
        _failures.pop(key, None)


def client_ip(request: Request):
    return request.client.host if request.client else "?"


# ---------- Sessions

def _expiry():
    return (datetime.now(timezone.utc) + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")


def _is_https(request: Request):
    if COOKIE_SECURE in ("true", "false"):
        return COOKIE_SECURE == "true"
    host = request.headers.get("host", "")
    return (request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
            or host.split(":")[0].endswith(".ts.net"))


def set_cookie(request: Request, response: Response, token):
    response.set_cookie(COOKIE, token, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax",
                        secure=_is_https(request), path="/")


def start_session(request: Request, response: Response, uid):
    token = new_token()
    db.create_session(token_hash(token), uid, _expiry())
    set_cookie(request, response, token)
    return token


def end_session(request: Request, response: Response):
    token = request.cookies.get(COOKIE)
    if token:
        db.delete_session(token_hash(token))
    response.delete_cookie(COOKIE, path="/")


def current_user(request: Request):
    """FastAPI dependency: the logged-in user, or 401."""
    token = request.cookies.get(COOKIE)
    if token:
        th = token_hash(token)
        user, expires = db.get_session(th)
        if user:
            # Sliding expiry: extend at most once a day.
            left = datetime.strptime(expires, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc) - datetime.now(timezone.utc)
            if left < timedelta(days=SESSION_DAYS - 1):
                db.extend_session(th, _expiry())
                request.state.refresh_cookie = token  # main.py sends the cookie again with a new max-age
            request.state.session_hash = th
            return user
    raise HTTPException(401, "Please log in.")


def admin_user(request: Request):
    user = current_user(request)
    if not user["isAdmin"]:
        raise HTTPException(403, "Only an administrator can do this.")
    return user


def ingest_user(request: Request):
    """The user of a shortcut key: 'Authorization: Bearer <key>' or 'X-Diary-Token: <key>'."""
    auth = request.headers.get("authorization", "")
    token = auth[7:].strip() if auth.lower().startswith("bearer ") else request.headers.get("x-diary-token", "").strip()
    user = db.user_by_ingest_token(token_hash(token)) if token else None
    if not user:
        raise HTTPException(401, "Missing or wrong shortcut key. Create one in Profile → Apple Health sync.")
    return user
