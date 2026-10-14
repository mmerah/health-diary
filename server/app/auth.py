"""Accounts: password hashing, sessions, shortcut keys and protection against password guessing."""
import hashlib
import hmac
import os
import secrets
import threading
import time
from collections import OrderedDict, deque
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request, Response

from . import db

COOKIE = "hd_session"
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))
# "auto": Secure cookie when the request came over HTTPS (Tailscale, or a trusted reverse proxy).
# "true"/"false" force it.
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "auto").lower()
MIN_PASSWORD, MAX_PASSWORD = 10, 1024

# scrypt with N=2^15, r=8: about 32 MB of memory and ~0.1 s for each check.
SCRYPT = {"n": 2 ** 15, "r": 8, "p": 1}
# At most 4 checks at the same time, so a flood of logins cannot use up the memory and CPU.
_scrypt_slots = threading.BoundedSemaphore(4)


def _scrypt(password, salt, n, r, p):
    if not _scrypt_slots.acquire(timeout=10):
        raise HTTPException(503, "The server is busy. Try again in a moment.")
    try:
        return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, maxmem=64 * 1024 * 1024, dklen=32)
    finally:
        _scrypt_slots.release()


def hash_password(password):
    salt = os.urandom(16)
    dk = _scrypt(password, salt, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${dk.hex()}"


def verify_password(password, stored):
    try:
        _, n, r, p, salt, expected = stored.split("$")
        dk = _scrypt(password, bytes.fromhex(salt), int(n), int(r), int(p))
    except (ValueError, AttributeError):
        return False
    return hmac.compare_digest(dk.hex(), expected)


# Checked when the username does not exist, so the answer takes the same time.
_DUMMY = hash_password(secrets.token_hex(8))


def authenticate(username, password):
    """Returns the user if the username and password match, else None."""
    user, stored = db.get_user_login(username)
    ok = verify_password(password, stored or _DUMMY)
    return user if user and ok else None


def check_new_password(password, username=""):
    if len(password or "") < MIN_PASSWORD:
        raise HTTPException(400, f"Use at least {MIN_PASSWORD} characters for the password.")
    if len(password) > MAX_PASSWORD:
        raise HTTPException(400, f"Use at most {MAX_PASSWORD} characters for the password.")
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


# No 0/O, 1/I/L: easy to read in a log. 28 characters of 31 symbols: more than 128 bits.
SETUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def new_setup_code():
    chars = "".join(secrets.choice(SETUP_ALPHABET) for _ in range(28))
    return "-".join(chars[i:i + 4] for i in range(0, 28, 4))


def same_setup_code(given, expected):
    def norm(s):
        return "".join(ch for ch in str(s or "").upper() if ch.isalnum())
    return hmac.compare_digest(norm(given).encode(), norm(expected).encode())


# ---------- Rate limits

class Limiter:
    """Counts events per key in a sliding window. The table is pruned and never grows past max_keys."""

    def __init__(self, limit, window, max_keys=10_000):
        self.limit, self.window, self.max_keys = limit, window, max_keys
        self._hits = OrderedDict()
        self._lock = threading.Lock()

    def _recent(self, key, now):
        q = self._hits.get(key)
        while q and now - q[0] > self.window:
            q.popleft()
        if q is not None and not q:
            del self._hits[key]
            return None
        return q

    def wait(self, key):
        """Seconds to wait before the next try, or 0."""
        with self._lock:
            now = time.monotonic()
            q = self._recent(key, now)
            return int(self.window - (now - q[0])) + 1 if q and len(q) >= self.limit else 0

    def hit(self, key):
        with self._lock:
            now = time.monotonic()
            q = self._recent(key, now) or self._hits.setdefault(key, deque())
            q.append(now)
            self._hits.move_to_end(key)
            while len(self._hits) > self.max_keys:  # drop the keys that were quiet the longest
                self._hits.popitem(last=False)

    def clear(self, key=None):
        with self._lock:
            if key is None:
                self._hits.clear()
            else:
                self._hits.pop(key, None)


WINDOW = 15 * 60
# Login: 5 failures for one username from one address (hard). A wrong password from someone
# else cannot lock you out. 30 failures from one address for any usernames (soft).
LOGIN_USER = Limiter(5, WINDOW)
LOGIN_IP = Limiter(30, WINDOW)
# Setup code: 5 failures per address, and 20 in total, in 15 minutes.
SETUP_IP = Limiter(5, WINDOW)
SETUP_ALL = Limiter(20, WINDOW)
# Shortcut: 30 sends in 10 minutes per user is far more than a shortcut needs.
INGEST = Limiter(30, 10 * 60)
LIMITERS = (LOGIN_USER, LOGIN_IP, SETUP_IP, SETUP_ALL, INGEST)


def check_limits(*pairs, message="Too many failed attempts."):
    """pairs: (limiter, key). Raises 429 if one of them is over its limit."""
    wait = max(limiter.wait(key) for limiter, key in pairs)
    if wait:
        raise HTTPException(429, f"{message} Try again in {wait // 60 + 1} minutes.",
                            headers={"Retry-After": str(wait)})


def record(*pairs):
    for limiter, key in pairs:
        limiter.hit(key)


def reset_limits():
    for limiter in LIMITERS:
        limiter.clear()


def client_ip(request: Request):
    # Uvicorn takes X-Forwarded-For into account only from FORWARDED_ALLOW_IPS (default 127.0.0.1).
    return request.client.host if request.client else "?"


# ---------- Sessions

def _expiry():
    return (datetime.now(UTC) + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")


def _is_https(request: Request):
    if COOKIE_SECURE in ("true", "false"):
        return COOKIE_SECURE == "true"
    # The scheme includes X-Forwarded-Proto only from a trusted proxy (FORWARDED_ALLOW_IPS).
    # Tailscale (Docktail, tailscale serve) gives HTTPS on *.ts.net but talks plain HTTP to the container.
    host = request.headers.get("host", "").split(":")[0]
    return request.url.scheme == "https" or host.endswith(".ts.net")


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


def session_user(request: Request, response: Response):
    """The logged-in user, or None. Renews the session (sliding expiry) at most once a day;
    the new cookie goes out on `response`."""
    token = request.cookies.get(COOKIE)
    if not token:
        return None
    th = token_hash(token)
    user, expires = db.get_session(th)
    if not user:
        return None
    left = datetime.strptime(expires, "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC) - datetime.now(UTC)
    if left < timedelta(days=SESSION_DAYS - 1):
        db.extend_session(th, _expiry())
        set_cookie(request, response, token)
    request.state.session_hash = th
    return user


def current_user(request: Request, response: Response):
    """FastAPI dependency: the logged-in user, or 401. FastAPI merges `response` headers
    (the renewed cookie) into the endpoint's response."""
    user = session_user(request, response)
    if not user:
        raise HTTPException(401, "Please log in.")
    return user


def admin_user(user=Depends(current_user)):
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
    check_limits((INGEST, user["id"]), message="Too many syncs.")
    record((INGEST, user["id"]))
    return user
