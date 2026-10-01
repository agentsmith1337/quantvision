"""End-to-end API tests against the simulated feed and the paper broker.

Tests run in file order and share one app instance (setup happens once).
"""

import sqlite3
from pathlib import Path

import pytest
from starlette.websockets import WebSocketDisconnect

from tests.conftest import FAKE_ANGEL, USER, wait_for


def quote(client, symbol):
    r = client.get(f"/api/market/quote/{symbol}")
    return r.json() if r.status_code == 200 else None


# --- security boundary --------------------------------------------------------


def test_foreign_host_header_rejected(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 400


def test_everything_requires_sign_in_before_setup(client):
    status = client.get("/api/auth/status").json()
    assert status == {"setup_complete": False, "signed_in": False, "user": None, "env_credentials_available": False}
    for path in ("/api/orders", "/api/portfolio/holdings", "/api/settings", "/api/market/instruments", "/api/broker/status"):
        assert client.get(path).status_code == 401, path
    assert client.post("/api/orders", json={"symbol": "SBIN", "side": "BUY", "quantity": 1}).status_code == 401


def test_websocket_rejects_unauthenticated(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/market") as ws:
            ws.receive_json()


def test_setup_creates_account_and_signs_in(client):
    r = client.post("/api/auth/setup", json={**USER, "angel": FAKE_ANGEL, "static_ips": {"primary": "203.0.113.7"}})
    assert r.status_code == 200, r.text
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=strict" in cookie
    assert client.get("/api/auth/status").json()["signed_in"] is True
    # A second setup must not be able to replace the account.
    assert client.post("/api/auth/setup", json=USER).status_code == 409


def test_credentials_are_encrypted_at_rest(client, home):
    db = sqlite3.connect(Path(home) / "quantvision.db")
    dump = "\n".join(db.iterdump())
    db.close()
    for secret in (FAKE_ANGEL["pin"] * 2, FAKE_ANGEL["totp_secret"], FAKE_ANGEL["api_key"]):
        assert secret not in dump
    creds = client.get("/api/broker/status").json()["credentials"]
    assert creds == {"api_key": "Ab…34", "client_code": "A1234567"}  # masked, never the PIN/secret


def test_invalid_totp_secret_rejected(client):
    bad = {**FAKE_ANGEL, "totp_secret": "123456"}
    r = client.put("/api/broker/credentials", json={"angel": bad, "verify": False})
    assert r.status_code == 422


# --- paper trading --------------------------------------------------------------


def test_trading_defaults_to_paper(client):
    assert client.get("/api/broker/status").json()["trading_mode"] == "paper"
    # QV_MARKET_DATA=simulated means there is no live broker to switch to.
    assert client.put("/api/broker/mode", json={"mode": "live"}).status_code == 400


def test_market_buy_fills_and_updates_holdings(client):
    ltp = wait_for(lambda: quote(client, "SBIN"))["ltp"]
    cash_before = client.get("/api/portfolio/funds").json()["funds"]["available_cash"]
    r = client.post("/api/orders", json={"symbol": "SBIN", "side": "BUY", "quantity": 10})
    assert r.status_code == 200, r.text
    order = r.json()["order"]
    assert order["status"] == "complete" and order["filled_quantity"] == 10
    assert abs(order["average_price"] - ltp) / ltp < 0.01
    holdings = client.get("/api/portfolio/holdings").json()["holdings"]
    assert [(h["symbol"], h["quantity"]) for h in holdings] == [("SBIN", 10)]
    cash_after = client.get("/api/portfolio/funds").json()["funds"]["available_cash"]
    assert cash_after == pytest.approx(cash_before - 10 * order["average_price"], abs=0.05)
    assert client.get("/api/orders/trades").json()["trades"][0]["quantity"] == 10


def test_cannot_sell_more_than_held(client):
    r = client.post("/api/orders", json={"symbol": "SBIN", "side": "SELL", "quantity": 11})
    assert r.status_code == 400 and "hold 10" in r.json()["detail"]


def test_limit_order_rests_then_cancels(client):
    ltp = quote(client, "TCS")["ltp"] if quote(client, "TCS") else wait_for(lambda: quote(client, "TCS"))["ltp"]
    r = client.post("/api/orders", json={"symbol": "TCS", "side": "BUY", "quantity": 1, "order_type": "LIMIT", "price": round(ltp * 0.5, 1)})
    order = r.json()["order"]
    assert order["status"] == "open" and order["is_open"]
    assert client.delete(f"/api/orders/{order['order_id']}").status_code == 200
    statuses = {o["order_id"]: o["status"] for o in client.get("/api/orders").json()["orders"]}
    assert statuses[order["order_id"]] == "cancelled"


def test_order_validation(client):
    assert client.post("/api/orders", json={"symbol": "SBIN", "side": "BUY", "quantity": 1, "order_type": "LIMIT"}).status_code == 422
    assert client.post("/api/orders", json={"symbol": "SBIN", "side": "BUY", "quantity": 0}).status_code == 422
    assert client.post("/api/orders", json={"symbol": "NIFTY", "side": "BUY", "quantity": 1}).status_code == 400
    sl = {"symbol": "SBIN", "side": "BUY", "quantity": 1, "order_type": "SL", "price": 100, "trigger_price": 110}
    assert client.post("/api/orders", json=sl).status_code == 422  # buy-stop trigger above limit


def test_max_order_value_guard(client):
    client.put("/api/settings/risk", json={"max_order_value": 1000, "max_orders_per_minute": 10})
    r = client.post("/api/orders", json={"symbol": "SBIN", "side": "BUY", "quantity": 100})
    assert r.status_code == 400 and "exceeds your limit" in r.json()["detail"]


def test_order_rate_limit_and_cancel_all(client):
    client.put("/api/settings/risk", json={"max_order_value": 1_000_000, "max_orders_per_minute": 2})
    ltp = wait_for(lambda: quote(client, "INFY"))["ltp"]
    limit = {"symbol": "INFY", "side": "BUY", "quantity": 1, "order_type": "LIMIT", "price": round(ltp * 0.5, 1)}
    # Earlier tests already used part of this minute's budget.
    codes = [client.post("/api/orders", json=limit).status_code for _ in range(3)]
    assert 400 in codes
    result = client.post("/api/orders/cancel-all").json()
    assert not result["failed"]
    assert not [o for o in client.get("/api/orders").json()["orders"] if o["is_open"]]
    client.put("/api/settings/risk", json={"max_order_value": 1_000_000, "max_orders_per_minute": 60})


def test_order_events_reach_websocket(client):
    with client.websocket_connect("/ws/market") as ws:
        assert ws.receive_json()["type"] == "status"
        client.post("/api/orders", json={"symbol": "SBIN", "side": "SELL", "quantity": 5})
        msg = wait_for(lambda: m if (m := ws.receive_json())["type"] == "order" else None)
        assert msg["broker"] == "paper" and msg["order"]["status"] == "complete" and msg["order"]["side"] == "SELL"


def test_settings_validation(client):
    assert client.put("/api/settings/watchlist", json=["SBIN", "NOPE"]).status_code == 422
    assert client.put("/api/settings/static_ips", json={"primary": "not-an-ip"}).status_code == 422
    assert client.put("/api/settings/watchlist", json=["sbin", "tcs", "SBIN"]).json() == ["SBIN", "TCS"]


# --- session lifecycle ---------------------------------------------------------


def test_signout_locks_engine(client):
    assert client.post("/api/auth/signout").status_code == 200
    assert client.get("/api/orders").status_code == 401
    assert client.get("/api/health").json()["market"]["state"] == "locked"


def test_password_change_keeps_vault_readable(client):
    assert client.post("/api/auth/signin", json=USER).status_code == 200
    new = "an even better passphrase"
    assert client.put("/api/auth/password", json={"current_password": "wrong", "new_password": new}).status_code == 403
    assert client.put("/api/auth/password", json={"current_password": USER["password"], "new_password": new}).status_code == 200
    client.post("/api/auth/signout")
    assert client.post("/api/auth/signin", json=USER).status_code == 401
    assert client.post("/api/auth/signin", json={**USER, "password": new}).status_code == 200
    assert client.get("/api/broker/status").json()["credentials"]["client_code"] == FAKE_ANGEL["client_code"]
    # Paper holdings survive the restart of the engine.
    assert client.get("/api/portfolio/holdings").json()["holdings"][0]["quantity"] == 5


def test_sign_in_is_throttled(client):
    client.post("/api/auth/signout")
    codes = [client.post("/api/auth/signin", json={**USER, "password": "nope-nope"}).status_code for _ in range(6)]
    assert codes[-1] == 429
