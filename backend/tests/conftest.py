import os
import tempfile
import time

import pytest

# Configure before the app is imported: isolated data dir, no broker network access.
_home = tempfile.mkdtemp(prefix="qv-test-")
os.environ.update({
    "QV_HOME": _home,
    "QV_MARKET_DATA": "simulated",
    "QV_ALLOWED_HOSTS": "testserver,127.0.0.1,localhost",
    "QV_FRONTEND_DIST": os.path.join(_home, "no-ui"),
    # Present-but-empty keys stop backend/.env from leaking real credentials into tests.
    "ANGEL_API_KEY": "", "ANGEL_CLIENT_CODE": "", "ANGEL_PIN": "", "ANGEL_TOTP_SECRET": "",
})

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402

USER = {"username": "trader", "password": "correct horse battery"}
FAKE_ANGEL = {"api_key": "AbCd1234", "client_code": "A1234567", "pin": "1234", "totp_secret": "JBSWY3DPEHPK3PXPJBSWY3DPEH"}


@pytest.fixture(scope="session")
def home() -> str:
    return _home


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


def wait_for(fn, timeout: float = 5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if (value := fn()) is not None:
            return value
        time.sleep(0.1)
    raise AssertionError("timed out")
