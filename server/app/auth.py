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


def _norm_code(s):
    return "".join(ch for ch in str(s or "").upper() if ch.isalnum())


def strong_enough(code):
    """A fixed SETUP_CODE must have at least 16 letters or digits."""
    return len(_norm_code(code)) >= 16


def same_setup_code(given, expected):
    return hmac.compare_digest(_norm_code(given).encode(), _norm_code(expected).encode())


# ---------- Rate limits
#
# A try is counted BEFORE the password is checked (reserve), under a lock. So parallel
# requests cannot all pass the check before the first failure is counted.
# When the try was right, succeeded() takes the count back.

class Limiter:
    """At most `limit` tries per key in a sliding window. The table never grows past max_keys."""

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

    def reserve(self, key):
        """Counts one try. Returns 0, or the seconds to wait (the try is then not counted)."""
        with self._lock:
            now = time.monotonic()
            q = self._recent(key, now)
            if q and len(q) >= self.limit:
                return int(self.window - (now - q[0])) + 1
            q = q or self._hits.setdefault(key, deque())
            q.append(now)
            self._hits.move_to_end(key)
            while len(self._hits) > self.max_keys:  # drop the keys that were quiet the longest
                self._hits.popitem(last=False)
            return 0

    def undo(self, key):
        with self._lock:
            q = self._hits.get(key)
            if q:
                q.pop()
                if not q:
                    del self._hits[key]

    succeeded = undo  # a right password is not a failure

    def clear(self, key=None):
        with self._lock:
            self._hits.clear() if key is None else self._hits.pop(key, None)


class Backoff:
    """After each failure, the next try must wait twice as long: 1 s, 2 s, 4 s ... up to `cap` seconds.
    Unlike a lockout, the right person gets in again within a minute, even while someone guesses.
    After `reset` seconds without a try, the key starts over."""

    def __init__(self, cap=60, reset=15 * 60, max_keys=10_000):
        self.cap, self.reset, self.max_keys = cap, reset, max_keys
        self._state = OrderedDict()  # key -> [failures, next try allowed at, last try, previous "next"]
        self._lock = threading.Lock()

    def reserve(self, key):
        with self._lock:
            now = time.monotonic()
            st = self._state.get(key)
            if st and now - st[2] > self.reset:
                del self._state[key]
                st = None
            if st and now < st[1]:
                return int(st[1] - now) + 1
            n = (st[0] if st else 0) + 1
            self._state[key] = [n, now + min(self.cap, 2 ** (n - 1)), now, st[1] if st else 0]
            self._state.move_to_end(key)
            while len(self._state) > self.max_keys:
                self._state.popitem(last=False)
            return 0

    def undo(self, key):
        with self._lock:
            st = self._state.get(key)
            if st:
                st[0] -= 1
                st[1] = st[3]
                if st[0] <= 0:
                    del self._state[key]

    def succeeded(self, key):
        self.clear(key)

    def clear(self, key=None):
        with self._lock:
            self._state.clear() if key is None else self._state.pop(key, None)


# Login: one username from one address waits longer after each failure (hard, but never more than
# a minute). Behind a proxy that is not in FORWARDED_ALLOW_IPS all users share one address,
# so a hard lockout would let anyone lock you out. 30 failures from one address in 15 minutes (soft).
LOGIN_USER = Backoff()
LOGIN_IP = Limiter(30, 15 * 60)
# Setup code: the same backoff per address. No total limit: it would let anyone block the setup.
SETUP_IP = Backoff()
# Shortcut: 30 sends in 10 minutes per user is far more than a shortcut needs.
INGEST = Limiter(30, 10 * 60)
# Documents: 30 uploads per hour per user. Each one is read with OCR, which takes CPU.
DOC_UPLOAD = Limiter(30, 60 * 60)
LIMITERS = (LOGIN_USER, LOGIN_IP, SETUP_IP, INGEST, DOC_UPLOAD)


def _too_many(wait, message):
    when = f"{wait} seconds" if wait < 120 else f"{wait // 60 + 1} minutes"
    return HTTPException(429, f"{message} Try again in {when}.", headers={"Retry-After": str(wait)})


def attempt(*pairs, message="Too many failed attempts."):
    """pairs: (limiter, key). Counts one try on each, or none and raises 429."""
    done = []
    for limiter, key in pairs:
        wait = limiter.reserve(key)
        if wait:
            for d_limiter, d_key in done:
                d_limiter.undo(d_key)
            raise _too_many(wait, message)
        done.append((limiter, key))


def succeeded(*pairs):
    for limiter, key in pairs:
        limiter.succeeded(key)


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
    attempt((INGEST, user["id"]), message="Too many syncs.")
    return user
