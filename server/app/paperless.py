"""Reads medical documents from Paperless-ngx.

The Paperless address is set for the whole install ($PAPERLESS_URL). Each user saves their
own Paperless API token and tags in Profile, so users only see their own documents.
A document shows when it has ANY of the user's tags. Tokens are stored encrypted (crypto.py).
The token is only used to read: the diary never changes anything in Paperless.
"""
import logging
import os
import time
from urllib.parse import urlsplit, urlunsplit

import httpx

from . import crypto, db

log = logging.getLogger("uvicorn.error")
URL = os.environ.get("PAPERLESS_URL", "").rstrip("/")
DEFAULT_TAGS = ["medical"]  # each user sets their own tags in the app
MAX_TAGS = 20
# Address for "Open in Paperless" links on your devices. Defaults to PAPERLESS_URL.
PUBLIC_URL = os.environ.get("PAPERLESS_PUBLIC_URL", URL).rstrip("/")
CACHE_SECONDS = 300

_cache = {}  # user id -> (time, tags key, documents, missing tag names)
_tags = {}  # user id -> (time, [{id, name, document_count}])


class PaperlessError(Exception):
    """The message is plain text for the user."""


class NotSetUp(PaperlessError):
    """No Paperless address, or no token: nothing to ask."""


class Partial(PaperlessError):
    """Paperless gave only part of the list. `items` holds that part."""

    def __init__(self, items):
        super().__init__("Paperless gave only part of the list. Check PAPERLESS_URL.")
        self.items = items


def _origin(url):
    u = urlsplit(url)
    return (u.scheme.lower(), u.netloc.lower())


def forget(uid):
    """Drops the cached documents and tags of a user (new settings, or the user is gone)."""
    _cache.pop(uid, None)
    _tags.pop(uid, None)


def user_config(uid):
    """Returns (token, tags). Each user saves their own token."""
    cfg = db.get_kv(uid, "paperless", {})
    return crypto.decrypt(cfg.get("tokenEnc")) or "", cfg.get("tags") or list(DEFAULT_TAGS)


def configured(uid):
    return bool(URL and user_config(uid)[0])


def public_config(uid):
    """What the Profile screen may see. The token itself never leaves the server."""
    token, tags = user_config(uid)
    return {"available": bool(URL), "url": PUBLIC_URL, "tags": tags, "hasToken": bool(token),
            "missingTags": missing_tags(uid) if URL and token else []}


def save_config(uid, token=None, tags=None):
    """An empty token removes the user's token. Tags: names; duplicates (any case) count once;
    an empty list means the default tag."""
    with db.transaction():
        cfg = db.get_kv(uid, "paperless", {})
        if token is not None:
            token = token.strip()
            if token:
                cfg["tokenEnc"] = crypto.encrypt(token)
            else:
                cfg.pop("tokenEnc", None)
        if tags is not None:
            seen, clean = set(), []
            for t in (x.strip() for x in tags):
                if t and t.lower() not in seen:
                    seen.add(t.lower())
                    clean.append(t)
            cfg["tags"] = clean[:MAX_TAGS] or list(DEFAULT_TAGS)
        db.set_kv(uid, "paperless", cfg)
    forget(uid)


def _client(token):
    return httpx.Client(headers={"Authorization": f"Token {token}", "Accept": "application/json"},
                        timeout=20, follow_redirects=True)


def _next_page(next_url, path):
    """The address of the next page, on PAPERLESS_URL. Behind a proxy, Paperless often builds its
    page links with its public address: keep only their path and query. None if the link is not a
    page of the same list (the token is never sent elsewhere)."""
    n, base = urlsplit(next_url), urlsplit(URL)
    if _origin(next_url) == _origin(URL):
        return next_url
    if not n.path.endswith(path):
        return None
    return urlunsplit((base.scheme, base.netloc, base.path.rstrip("/") + path, n.query, ""))


def _get_all(client, path, params=None, partial=None):
    """Follows Paperless pagination ("next") and returns all results. When a page link cannot be
    followed: adds `path` to the list `partial` and returns what it has, or raises Partial."""
    out, url = [], f"{URL}{path}"
    while url:
        r = client.get(url, params=params)
        r.raise_for_status()
        data = r.json()
        out.extend(data["results"])
        url, params = data.get("next"), None
        if url:
            following = _next_page(url, path)
            if following is None:
                log.warning("Paperless sent a page link that the diary cannot follow (%s).", _origin(url)[1])
                if partial is None:
                    raise Partial(out)
                partial.append(path)
                break
            url = following
    return out


def _call(uid, work):
    """Runs work(client) with the user's token. Turns Paperless errors into plain messages."""
    token, _ = user_config(uid)
    try:
        with _client(token) as c:
            return work(c)
    except httpx.HTTPStatusError as e:
        raise PaperlessError(f"Paperless answered {e.response.status_code}. Check your Paperless token in Profile.") from e
    except httpx.HTTPError as e:
        raise PaperlessError("Cannot reach Paperless. Ask the administrator to check PAPERLESS_URL.") from e
    except (ValueError, KeyError, TypeError) as e:
        log.warning("Unexpected answer from Paperless: %r", e)
        raise PaperlessError("Paperless sent an answer that the diary cannot read.") from e


def _all_tags(uid, client, force=False, partial=None):
    hit = _tags.get(uid)
    if not force and hit and time.time() - hit[0] < CACHE_SECONDS:
        return hit[1]
    seen = [] if partial is None else partial
    tags = [{"id": t["id"], "name": t["name"], "document_count": t.get("document_count") or 0}
            for t in _get_all(client, "/api/tags/", {"page_size": 1000}, seen)]
    if not seen:  # cache only a complete list
        _tags[uid] = (time.time(), tags)
    return tags


def _resolve(tags, names):
    """Tag names -> (ids, names not found). Case does not matter."""
    by_name = {}
    for t in tags:
        by_name.setdefault(t["name"].lower(), t["id"])
    ids = [by_name[n.lower()] for n in names if n.lower() in by_name]
    return sorted(set(ids)), [n for n in names if n.lower() not in by_name]


def tag_list(uid):
    """All tags in the user's Paperless: [{name, documentCount}], by name."""
    if not URL:
        raise NotSetUp("Paperless is not set up on this server.")
    if not user_config(uid)[0]:
        raise NotSetUp("Save your Paperless token first.")
    tags = _call(uid, lambda c: _all_tags(uid, c, force=True))
    return sorted(({"name": t["name"], "documentCount": t["document_count"]} for t in tags),
                  key=lambda t: t["name"].casefold())


def missing_tags(uid):
    """The user's tag names that Paperless does not have. [] when Paperless cannot be asked."""
    hit = _cache.get(uid)
    _, names = user_config(uid)
    if hit and hit[1] == _key(names):
        return hit[3]
    try:
        return _call(uid, lambda c: _resolve(_all_tags(uid, c), names)[1])
    except PaperlessError:
        return []


def _key(names):
    return tuple(sorted(n.lower() for n in names))


def list_documents(uid, force=False):
    token, names = user_config(uid)
    if not URL or not token:
        return []
    hit = _cache.get(uid)
    if not force and hit and hit[1] == _key(names) and time.time() - hit[0] < CACHE_SECONDS:
        return hit[2]

    partial = []

    def work(c):
        ids, missing = _resolve(_all_tags(uid, c, force=force, partial=partial), names)
        if missing:
            log.info("Paperless has no tag named %s (user %s).", ", ".join(missing), uid)
        docs = []
        if ids:
            params = {"tags__id__in": ",".join(map(str, ids)), "page_size": 100, "ordering": "-created"}
            docs = _get_all(c, "/api/documents/", params, partial)

        def names_of(path):
            return {x["id"]: x["name"] for x in _get_all(c, path, {"page_size": 1000}, partial)}
        return docs, missing, names_of("/api/correspondents/") if docs else {}, \
            names_of("/api/document_types/") if docs else {}

    docs, missing, correspondents, types = _call(uid, work)
    result, seen = [], set()
    for d in docs:
        if d["id"] in seen:  # a document with two of the tags: once
            continue
        seen.add(d["id"])
        # documents.py adds the user's own category, date and title (kept in the diary, never sent to Paperless).
        result.append({
            "id": d["id"],
            "date": str(d.get("created") or d.get("created_date") or "")[:10],
            "title": d.get("title") or "Untitled",
            "type": types.get(d.get("document_type")) or None,
            "correspondent": correspondents.get(d.get("correspondent")) or "",
            "content": d.get("content") or "",
            "url": f"{PUBLIC_URL}/documents/{d['id']}/details",
            "added": str(d.get("added") or "")[:19] or None,
        })
    if partial:
        raise Partial(result)  # not cached: the next call tries again
    _cache[uid] = (time.time(), _key(names), result, missing)
    return result
