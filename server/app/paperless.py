"""Reads medical documents from Paperless-ngx.

The Paperless address is set for the whole install ($PAPERLESS_URL). Each user saves their
own Paperless API token and tag in Profile, so users only see their own documents.
Tokens are stored encrypted (see crypto.py). $PAPERLESS_TOKEN is a fallback for one
account only: the one named in $PAPERLESS_TOKEN_USER. Without that name, nobody uses it.
"""
import logging
import os
import time
from urllib.parse import urlsplit

import httpx

from . import crypto, db

log = logging.getLogger("uvicorn.error")
URL = os.environ.get("PAPERLESS_URL", "").rstrip("/")
ENV_TOKEN = os.environ.get("PAPERLESS_TOKEN", "")
ENV_TOKEN_USER = os.environ.get("PAPERLESS_TOKEN_USER", "").strip().lower()
DEFAULT_TAG = os.environ.get("PAPERLESS_TAG", "medical")
# Address for "Open in Paperless" links on your devices. Defaults to PAPERLESS_URL.
PUBLIC_URL = os.environ.get("PAPERLESS_PUBLIC_URL", URL).rstrip("/")
CACHE_SECONDS = 300

_cache = {}  # user id -> (time, documents)


class PaperlessError(Exception):
    """The message is plain text for the user."""


def _origin(url):
    u = urlsplit(url)
    return (u.scheme.lower(), u.netloc.lower())


def encrypt_old_tokens():
    """Older versions stored the token as plain text. Encrypt it once, at start."""
    for uid, cfg in db.all_kv("paperless"):
        if cfg.get("token"):
            cfg["tokenEnc"] = crypto.encrypt(cfg.pop("token"))
            db.set_kv(uid, "paperless", cfg)


def check_env():
    if ENV_TOKEN and not ENV_TOKEN_USER:
        log.warning("PAPERLESS_TOKEN is set, but PAPERLESS_TOKEN_USER is not. Nobody uses this token. "
                    "Set PAPERLESS_TOKEN_USER to the username that may use it.")


def forget(uid):
    """Drops the cached documents of a user (new settings, or the user is gone)."""
    _cache.pop(uid, None)


def user_config(uid):
    """Returns (token, tag, token_is_from_server)."""
    cfg = db.get_kv(uid, "paperless", {})
    own = crypto.decrypt(cfg.get("tokenEnc"))
    if own:
        return own, cfg.get("tag") or DEFAULT_TAG, False
    # Tied to a username, not to a role or an id: the token never moves to another person.
    user = db.get_user(uid) if ENV_TOKEN and ENV_TOKEN_USER else None
    env = ENV_TOKEN if user and user["username"].lower() == ENV_TOKEN_USER else ""
    return env, cfg.get("tag") or DEFAULT_TAG, bool(env)


def configured(uid):
    return bool(URL and user_config(uid)[0])


def public_config(uid):
    """What the Profile screen may see. The token itself never leaves the server."""
    token, tag, from_server = user_config(uid)
    return {"available": bool(URL), "url": PUBLIC_URL, "tag": tag, "hasToken": bool(token),
            "tokenFromServer": from_server}


def save_config(uid, token=None, tag=None):
    """An empty token removes the user's own token."""
    with db.transaction():
        cfg = db.get_kv(uid, "paperless", {})
        cfg.pop("token", None)
        if token is not None:
            token = token.strip()
            if token:
                cfg["tokenEnc"] = crypto.encrypt(token)
            else:
                cfg.pop("tokenEnc", None)
        if tag is not None:
            cfg["tag"] = tag.strip()
        db.set_kv(uid, "paperless", cfg)
    forget(uid)


def _get_all(client, path, params=None):
    """Follows Paperless pagination ("next") and returns all results.
    Follows only links to the Paperless address, so the token is never sent elsewhere."""
    out, url = [], f"{URL}{path}"
    while url:
        r = client.get(url, params=params)
        r.raise_for_status()
        data = r.json()
        out.extend(data["results"])
        url, params = data.get("next"), None
        if url and _origin(url) != _origin(URL):
            log.warning("Paperless sent a page link to another address (%s). It was not followed.", _origin(url)[1])
            break
    return out


def list_documents(uid, force=False):
    token, tag, _ = user_config(uid)
    if not URL or not token:
        return []
    hit = _cache.get(uid)
    if not force and hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    headers = {"Authorization": f"Token {token}", "Accept": "application/json"}
    try:
        with httpx.Client(headers=headers, timeout=20, follow_redirects=True) as c:
            docs = _get_all(c, "/api/documents/", {"tags__name__iexact": tag, "page_size": 100, "ordering": "-created"})
            def names(path):
                return {x["id"]: x["name"] for x in _get_all(c, path, {"page_size": 1000})}
            correspondents = names("/api/correspondents/")
            types = names("/api/document_types/")
    except httpx.HTTPStatusError as e:
        raise PaperlessError(f"Paperless answered {e.response.status_code}. Check your Paperless token in Profile.") from e
    except httpx.HTTPError as e:
        raise PaperlessError("Cannot reach Paperless. Ask the administrator to check PAPERLESS_URL.") from e
    except (ValueError, KeyError, TypeError) as e:
        log.warning("Unexpected answer from Paperless: %r", e)
        raise PaperlessError("Paperless sent an answer that the diary cannot read.") from e

    # documents.py adds the user's own category, date and title (kept in the diary, never sent to Paperless).
    result = [{
        "id": d["id"],
        "date": str(d.get("created") or d.get("created_date") or "")[:10],
        "title": d.get("title") or "Untitled",
        "type": types.get(d.get("document_type")) or None,
        "correspondent": correspondents.get(d.get("correspondent")) or "",
        "content": d.get("content") or "",
        "url": f"{PUBLIC_URL}/documents/{d['id']}/details",
        "added": str(d.get("added") or "")[:19] or None,
    } for d in docs]
    _cache[uid] = (time.time(), result)
    return result
