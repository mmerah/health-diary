"""Paperless with several tags per user, against a fake Paperless (httpx MockTransport)."""
import httpx
import pytest
from conftest import PW, login

from app import paperless

TAGS = [{"id": 1, "name": "Medical", "document_count": 3}, {"id": 2, "name": "lab", "document_count": 2},
        {"id": 3, "name": "Taxes", "document_count": 9}]
DOCS = {  # documents by tag id
    1: [{"id": 10, "title": "Letter", "created": "2026-05-01", "content": "Dear Dr", "document_type": None},
        {"id": 11, "title": "Blood test", "created": "2026-04-01", "content": "Hemoglobin", "document_type": 5}],
    2: [{"id": 11, "title": "Blood test", "created": "2026-04-01", "content": "Hemoglobin", "document_type": 5},
        {"id": 12, "title": "Lipids", "created": "2026-03-01", "content": "Cholesterol", "document_type": None}],
    3: [{"id": 13, "title": "Tax 2025", "created": "2026-02-01", "content": "", "document_type": None}],
}


@pytest.fixture
def fake(monkeypatch):
    base = "http://paperless.lan:8000"
    calls = []

    def handler(request):
        calls.append(request)
        if request.headers.get("authorization") != "Token good-token":
            return httpx.Response(401, json={"detail": "Invalid token."})
        path, q = request.url.path, request.url.params
        if path == "/api/tags/":
            # Two pages, to check that pagination is followed.
            if q.get("page") == "2":
                return httpx.Response(200, json={"results": TAGS[2:], "next": None})
            return httpx.Response(200, json={"results": TAGS[:2], "next": f"{base}/api/tags/?page=2"})
        if path == "/api/documents/":
            ids = [int(x) for x in q["tags__id__in"].split(",")]
            # Paperless itself does not repeat a document; the diary still checks it.
            return httpx.Response(200, json={"results": [d for i in ids for d in DOCS[i]], "next": None})
        if path == "/api/document_types/":
            return httpx.Response(200, json={"results": [{"id": 5, "name": "Blood test"}], "next": None})
        if path == "/api/correspondents/":
            return httpx.Response(200, json={"results": [], "next": None})
        return httpx.Response(404)

    monkeypatch.setattr(paperless, "URL", base)
    monkeypatch.setattr(paperless, "PUBLIC_URL", base)
    monkeypatch.setattr(paperless, "_client", lambda token: httpx.Client(
        transport=httpx.MockTransport(handler), headers={"Authorization": f"Token {token}"}))
    paperless._cache.clear()
    paperless._tags.clear()
    return calls


def test_several_tags(c, fake):
    cfg = c.get("/api/me/paperless").json()
    assert cfg == {"available": True, "url": "http://paperless.lan:8000", "tags": ["medical"], "hasToken": False,
                   "missingTags": []}
    cfg = c.put("/api/me/paperless", json={"token": "good-token", "tags": ["medical", "LAB", "Lab", "x-ray"]}).json()
    assert cfg["tags"] == ["medical", "LAB", "x-ray"] and cfg["hasToken"] is True
    assert cfg["missingTags"] == ["x-ray"]  # Paperless has no such tag: ignored, and reported

    docs = [d for d in c.get("/api/documents").json()["documents"] if d["source"] == "paperless"]
    assert [d["id"] for d in docs] == [10, 11, 12]  # any of the tags; 11 has both and shows once
    q = [r for r in fake if r.url.path == "/api/documents/"][-1].url.params
    assert q["tags__id__in"] == "1,2"
    assert next(d for d in docs if d["id"] == 11)["paperlessType"] == "Blood test"

    # The cache follows the tag set: new tags give a new list at once.
    c.put("/api/me/paperless", json={"tags": ["taxes"]})
    assert [d["id"] for d in c.get("/api/documents").json()["documents"] if d["source"] == "paperless"] == [13]


def test_empty_tag_list_means_the_default(c, fake):
    assert c.put("/api/me/paperless", json={"tags": []}).json()["tags"] == ["medical"]
    assert c.put("/api/me/paperless", json={"tags": ["x" * 101]}).status_code == 400
    assert c.put("/api/me/paperless", json={"tags": ["a"] * 21}).status_code == 400
    assert c.put("/api/me/paperless", json={"tag": "medical"}).status_code == 400


def test_tag_list(c, fake):
    c.put("/api/me/paperless", json={"token": "good-token"})
    assert c.get("/api/me/paperless/tags").json() == [
        {"name": "lab", "documentCount": 2}, {"name": "Medical", "documentCount": 3},
        {"name": "Taxes", "documentCount": 9}]


def test_tag_list_errors(c, fake):
    c.post("/api/users", json={"username": "ida", "password": PW})
    ida = login("ida")
    r = ida.get("/api/me/paperless/tags")
    assert r.status_code == 400 and r.json()["detail"] == "Save your Paperless token first."
    ida.put("/api/me/paperless", json={"token": "wrong-token"})
    r = ida.get("/api/me/paperless/tags")
    assert r.status_code == 502 and "Check your Paperless token" in r.json()["detail"]
    # The list still works, with the Paperless error beside it.
    r = ida.get("/api/documents").json()
    assert r["paperless"]["ok"] is False and "Check your Paperless token" in r["paperless"]["error"]
    assert ida.get("/api/me/paperless").json()["missingTags"] == []


def test_tags_are_per_user(c, fake):
    c.put("/api/me/paperless", json={"token": "good-token", "tags": ["lab"]})
    c.post("/api/users", json={"username": "jon", "password": PW})
    jon = login("jon")
    assert jon.get("/api/me/paperless").json()["tags"] == ["medical"]
    assert c.get("/api/me/paperless").json()["tags"] == ["lab"]


def test_page_links_from_the_public_host(c, monkeypatch):
    """Behind a proxy, Paperless writes page links with its public host. The diary asks the same
    page on PAPERLESS_URL. A link to another path is not followed: the list is partial, and the
    token never goes to another host."""
    base = "http://10.0.0.5:8000"
    requests = []

    def handler(request):
        requests.append(request)
        path, page = request.url.path, request.url.params.get("page", "1")
        if path == "/api/tags/":
            return httpx.Response(200, json={"results": [{"id": 1, "name": "medical", "document_count": 3}],
                                             "next": None})
        if path == "/api/documents/":
            nxt = {"1": "https://paperless.example.com/api/documents/?page=2&tags__id__in=1",
                   "2": "https://evil.example.com/steal?page=3"}.get(page)
            return httpx.Response(200, json={"results": [{"id": int(page) * 10, "title": f"Doc {page}",
                                                          "created": "2026-01-0" + page, "content": ""}],
                                             "next": nxt})
        return httpx.Response(200, json={"results": [], "next": None})

    monkeypatch.setattr(paperless, "URL", base)
    monkeypatch.setattr(paperless, "_client", lambda token: httpx.Client(
        transport=httpx.MockTransport(handler), headers={"Authorization": f"Token {token}"}))
    paperless._cache.clear()
    paperless._tags.clear()
    c.put("/api/me/paperless", json={"token": "good-token", "tags": ["medical"]})
    r = c.get("/api/documents").json()
    assert [d["id"] for d in r["documents"] if d["source"] == "paperless"] == [20, 10]  # pages 1 and 2
    assert r["paperless"] == {"ok": False, "error": "Paperless gave only part of the list. Check PAPERLESS_URL."}
    assert all(req.url.host == "10.0.0.5" for req in requests)
    page2 = [req for req in requests if req.url.params.get("page") == "2"][0]
    assert str(page2.url) == f"{base}/api/documents/?page=2&tags__id__in=1"
    assert page2.headers["authorization"] == "Token good-token"
