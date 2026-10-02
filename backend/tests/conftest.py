import os
import sys
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
    # Run strategy scripts with this interpreter instead of building the sandbox venv.
    "QV_SCRIPT_PYTHON": sys.executable,
})

from datetime import datetime  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402
from app.market.scripmaster import IST, ScripRow, scripmaster  # noqa: E402

# A small scrip master dated today, so the app never downloads the real 34 MB file in tests.
SCRIP_ROWS = [
    ScripRow("NSE", "RELIANCE-EQ", "2885", "RELIANCE", False, "Reliance Industries"),
    ScripRow("NSE", "TATASTEEL-EQ", "3499", "TATASTEEL", False, "Tata Steel"),
    ScripRow("NSE", "TATAPOWER-EQ", "3426", "TATAPOWER", False, "The Tata Power Company"),
    ScripRow("NSE", "HDFCBANK-EQ", "1333", "HDFCBANK", False, "HDFC Bank"),
    ScripRow("NSE", "HDFCAMC-EQ", "4244", "HDFCAMC", False, "HDFC Asset Management Company"),
    ScripRow("NSE", "M&M-EQ", "2031", "M&M", False, "Mahindra & Mahindra"),
    ScripRow("NSE", "SBIN-EQ", "3045", "SBIN", False, "State Bank of India"),
    ScripRow("BSE", "RELIANCE", "500325", "RELIANCE", False, "Reliance Industries"),
    ScripRow("BSE", "UTIQUE", "500014", "UTIQUE", False),  # BSE-only: no company name
    ScripRow("NSE", "Nifty 50", "99926000", "NIFTY", True, "Nifty 50"),
    ScripRow("NSE", "Nifty IT", "99926008", "NIFTY IT", True, "Nifty IT"),
]
scripmaster.set_rows(SCRIP_ROWS, datetime.now(IST).date().isoformat())

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


def signin(client) -> None:
    """Sign in regardless of what earlier test modules did (throttle, password change)."""
    from app.security import sessions

    sessions._failures.clear()
    if not client.get("/api/auth/status").json()["setup_complete"]:
        assert client.post("/api/auth/setup", json=USER).status_code == 200
        return
    for password in (USER["password"], "an even better passphrase"):
        if client.post("/api/auth/signin", json={**USER, "password": password}).status_code == 200:
            return
    raise AssertionError("couldn't sign in")
