from conftest import PW, new_client

from app import auth, main


def test_setup_code_has_a_total_cap(server):
    # Many addresses, each under its own limit: the total cap still stops them.
    codes = []
    for i in range(auth.SETUP_ALL.limit + 1):
        x = new_client(client=(f"203.0.113.{i}", 5000))
        codes.append(x.post("/api/auth/setup", json={"code": "AAAA", "username": "eve", "password": PW}).status_code)
    assert codes[:-1] == [403] * auth.SETUP_ALL.limit and codes[-1] == 429
    # Even the right code waits now.
    r = new_client().post("/api/auth/setup", json={"code": main.SETUP_CODE, "username": "anna", "password": PW})
    assert r.status_code == 429
    auth.reset_limits()
