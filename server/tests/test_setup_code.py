from conftest import PW, new_client

from app import auth, main


def test_many_addresses_cannot_block_the_setup(server):
    # There is no total limit: failures from many addresses never lock out the owner.
    for i in range(50):
        x = new_client(client=(f"203.0.113.{i}", 5000))
        assert x.post("/api/auth/setup", json={"code": "AAAA", "username": "eve", "password": PW}).status_code == 403
    # One address waits longer after each failure.
    x = new_client(client=("203.0.113.1", 5000))
    r = x.post("/api/auth/setup", json={"code": "AAAA", "username": "eve", "password": PW})
    assert r.status_code == 429 and int(r.headers["Retry-After"]) <= 60
    r = new_client().post("/api/auth/setup", json={"code": main.SETUP_CODE, "username": "anna", "password": PW})
    assert r.status_code == 200
    auth.reset_limits()


def test_setup_code_is_always_random(server, monkeypatch):
    # There is no setting for it: a fixed code could be weak or reused.
    monkeypatch.setenv("SETUP_CODE", "my-own-setup-code-2026")
    with new_client():
        assert main.SETUP_CODE != "my-own-setup-code-2026" and len(main.SETUP_CODE) == 34
