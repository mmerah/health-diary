"""Reads medical documents from Paperless-ngx.

The Paperless address is set for the whole install ($PAPERLESS_URL). Each user saves their
own Paperless API token and tag in Profile, so users only see their own documents.
$PAPERLESS_TOKEN is a fallback for the first account only.
"""
import os
import time

import httpx

from . import db

URL = os.environ.get("PAPERLESS_URL", "").rstrip("/")
ENV_TOKEN = os.environ.get("PAPERLESS_TOKEN", "")
DEFAULT_TAG = os.environ.get("PAPERLESS_TAG", "medical")
# Address for "Open in Paperless" links on your devices. Defaults to PAPERLESS_URL.
PUBLIC_URL = os.environ.get("PAPERLESS_PUBLIC_URL", URL).rstrip("/")
CACHE_SECONDS = 300

_cache = {}  # user id -> (time, documents)


class PaperlessError(Exception):
    pass


def user_config(uid):
    cfg = db.get_kv(uid, "paperless", {})
    token = cfg.get("token") or (ENV_TOKEN if uid == 1 else "")
    return token, cfg.get("tag") or DEFAULT_TAG


def public_config(uid):
    """What the Profile screen may see. The token itself never leaves the server."""
    cfg = db.get_kv(uid, "paperless", {})
    token, tag = user_config(uid)
    return {"available": bool(URL), "url": PUBLIC_URL, "tag": tag, "hasToken": bool(token),
            "tokenFromServer": bool(token and not cfg.get("token"))}


def save_config(uid, token=None, tag=None):
    cfg = db.get_kv(uid, "paperless", {})
    if token is not None:
        cfg["token"] = token.strip()
    if tag is not None:
        cfg["tag"] = tag.strip()
    db.set_kv(uid, "paperless", cfg)
    _cache.pop(uid, None)


def _get_all(client, path, params=None):
    """Follows Paperless pagination ("next") and returns all results."""
    out, url = [], f"{URL}{path}"
    while url:
        r = client.get(url, params=params)
        r.raise_for_status()
        data = r.json()
        out.extend(data["results"])
        url, params = data.get("next"), None
    return out


def list_documents(uid, force=False):
    token, tag = user_config(uid)
    if not URL or not token:
        return []
    hit = _cache.get(uid)
    if not force and hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    headers = {"Authorization": f"Token {token}", "Accept": "application/json"}
    try:
        with httpx.Client(headers=headers, timeout=20, follow_redirects=True) as c:
            docs = _get_all(c, "/api/documents/", {"tags__name__iexact": tag, "page_size": 100, "ordering": "-created"})
            names = lambda path: {x["id"]: x["name"] for x in _get_all(c, path, {"page_size": 1000})}
            correspondents = names("/api/correspondents/")
            types = names("/api/document_types/")
    except httpx.HTTPStatusError as e:
        raise PaperlessError(f"Paperless answered {e.response.status_code}. Check your Paperless token in Profile.") from e
    except httpx.HTTPError as e:
        raise PaperlessError("Cannot reach Paperless. Ask the administrator to check PAPERLESS_URL.") from e

    result = [{
        "id": d["id"],
        "date": str(d.get("created") or d.get("created_date") or "")[:10],
        "title": d.get("title") or "Untitled",
        "category": types.get(d.get("document_type")) or "Document",
        "correspondent": correspondents.get(d.get("correspondent")) or "",
        "content": d.get("content") or "",
        "url": f"{PUBLIC_URL}/documents/{d['id']}/details",
    } for d in docs]
    _cache[uid] = (time.time(), result)
    return result
