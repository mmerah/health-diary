import os
import sys
import tempfile
from pathlib import Path

os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["TZ"] = "Europe/Paris"
os.environ["WEB_DIR"] = str(Path(__file__).resolve().parents[2] / "web")
os.environ["COOKIE_SECURE"] = "false"
os.environ.pop("DIARY_SECRET_KEY", None)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import auth, db, main, paperless  # noqa: E402

PW = "correct horse battery"
# The web app sends this header on every request (see the CSRF check in main.py).
HEADERS = {"X-Requested-With": "health-diary"}


def new_client(**kwargs):
    return TestClient(main.app, headers={**HEADERS, **kwargs.pop("headers", {})}, **kwargs)


@pytest.fixture(scope="module")
def server(tmp_path_factory):
    """A fresh install (empty data folder) for each test module, so modules do not depend on each other."""
    db.configure(tmp_path_factory.mktemp("data"))
    auth.reset_limits()
    paperless._cache.clear()
    with new_client() as c:  # runs the lifespan: db.init(), secret key, setup code
        yield c


@pytest.fixture(scope="module")
def c(server):
    """The administrator 'anna', created through the first-setup screen."""
    if server.get("/api/auth/status").json()["user"]:  # the module did the setup itself
        return server
    r = server.post("/api/auth/setup", json={"code": main.SETUP_CODE, "username": "anna", "password": PW})
    assert r.status_code == 200, r.text
    return server


def login(username, password=PW, **kwargs):
    x = new_client(**kwargs)
    r = x.post("/api/auth/login", json={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return x
