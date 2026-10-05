"""Strategy scripts: storage, candle building and end-to-end runs on the paper broker."""

import time
from datetime import datetime

import pytest

from app.market.hub import Tick
from app.scripts import service
from app.scripts.candles import CandleBuilder, bucket_start
from app.scripts.store import ScriptError, ScriptStore, check_syntax, script_defaults
from tests.conftest import signin, wait_for

IST_OFFSET = 19800


def ist(hh: int, mm: int, ss: int = 0, day: str = "2026-10-05") -> float:
    """Epoch seconds for an IST wall-clock time."""
    return datetime.fromisoformat(f"{day}T{hh:02d}:{mm:02d}:{ss:02d}+05:30").timestamp()


# --- candles -------------------------------------------------------------------------------


def test_buckets_align_to_the_0915_open():
    assert bucket_start(ist(9, 17, 30), 60) == ist(9, 17)
    assert bucket_start(ist(9, 19, 59), 300) == ist(9, 15)
    assert bucket_start(ist(10, 14, 59), 3600) == ist(9, 15)  # hourly: 09:15, 10:15, …
    assert bucket_start(ist(10, 15), 3600) == ist(10, 15)
    assert bucket_start(ist(15, 29), 86400) == ist(0, 0)


def test_builder_closes_on_next_bucket_and_on_timeout():
    now = [ist(9, 15, 5)]
    b = CandleBuilder(clock=lambda: now[0])
    got = []
    b.subscribe("SBIN", "1m", lambda s, i, c: got.append(c))

    def tick(t: float, price: float, vol: int) -> None:
        b.on_tick(Tick("SBIN", price, int(t * 1000), volume=vol))

    tick(ist(9, 15, 5), 100, 1000)
    tick(ist(9, 15, 30), 102, 1500)
    tick(ist(9, 15, 50), 99, 1700)
    assert got == []
    tick(ist(9, 16, 1), 101, 1800)  # next bucket closes the 09:15 candle
    assert got == [{"time": ist(9, 15), "open": 100, "high": 102, "low": 99, "close": 99, "volume": 700}]
    now[0] = ist(9, 17, 2)  # quiet stock: closed by the timer after the interval + grace
    b.close_due()
    assert got[1]["time"] == ist(9, 16) and got[1]["close"] == 101 and got[1]["volume"] == 100


# --- storage ---------------------------------------------------------------------------------


def test_store_seeds_examples_and_validates_names(tmp_path):
    store = ScriptStore(tmp_path / "scripts")
    assert {s["name"] for s in store.list()} == {"rsi_reversal.py", "sma_crossover.py"}
    for bad in ("../evil.py", "x.txt", "a b.py", "con.py/x"):
        with pytest.raises(ScriptError):
            store.write(bad, "")
    store.write("mine.py", "x = 1")
    store.rename("mine.py", "ours.py")
    assert store.read("ours.py") == "x = 1"


def test_defaults_and_syntax_are_read_without_running_the_script():
    src = 'import os\nos.system("echo hacked")\nSYMBOLS = ["sbin", "tcs"]\nINTERVAL = "15m"\ndef on_candle(c, i, a): pass\n'
    assert script_defaults(src) == {"symbols": ["SBIN", "TCS"], "interval": "15m", "has_on_candle": True}
    assert check_syntax("def on_candle(:\n", "x.py").startswith("x.py, line 1")


# --- end-to-end runs ---------------------------------------------------------------------------

STRATEGY = '''
SYMBOLS = ["SBIN", "TCS"]
INTERVAL = "1m"

bought = False

def on_start(api):
    print("hello from", api.mode)

def on_candle(candle, indicators, api):
    global bought
    api.log("candle", candle.symbol, candle.close, "sma3", indicators.sma(period=3))
    if candle.symbol == "SBIN" and not bought:
        bought = True
        before = api.position()
        o = api.buy(quantity=2)
        api.log("bought", o.status, o.order_id, "position delta", api.position() - before)
    if candle.symbol == "TCS":
        api.log("tcs rsi", indicators.rsi(period=14, symbol="SBIN") is not None)
        api.buy(quantity=1, symbol="INFY")  # not in the universe -> error

def on_order(order, api):
    api.log("on_order", order.symbol, order.status)
'''


def _candle(symbol: str, t: float, price: float) -> None:
    service.builder._emit([((symbol, "1m"), {"time": int(t), "open": price, "high": price, "low": price, "close": price, "volume": 10})])


def _logs(client, run_id: str) -> str:
    return "\n".join(e["text"] for e in client.get(f"/api/runs/{run_id}/logs").json())


def _wait_log(client, run_id: str, text: str, timeout: float = 15):
    return wait_for(lambda: True if text in _logs(client, run_id) else None, timeout)


@pytest.fixture
def signed_in(client):
    signin(client)
    wait_for(lambda: client.get("/api/market/quote/SBIN").json() if client.get("/api/market/quote/SBIN").status_code == 200 else None)
    return client


def test_script_api_endpoints(signed_in):
    c = signed_in
    assert c.put("/api/scripts/e2e.py", json={"content": STRATEGY}).json()["defaults"]["symbols"] == ["SBIN", "TCS"]
    assert "e2e.py" in {s["name"] for s in c.get("/api/scripts").json()}
    assert "on_candle" in c.get("/api/scripts/reference").json()["markdown"]
    assert c.get("/api/scripts/runtime").json()["state"] == "ready"
    assert c.post("/api/runs", json={"script": "e2e.py", "symbols": ["NOPE"], "interval": "1m"}).status_code == 400
    c.put("/api/scripts/broken.py", json={"content": "def on_candle(:"})
    r = c.post("/api/runs", json={"script": "broken.py", "symbols": ["SBIN"], "interval": "1m"})
    assert r.status_code == 400 and "Syntax error" in r.json()["detail"]


def test_run_end_to_end_on_paper(signed_in):
    c = signed_in
    c.put("/api/scripts/e2e.py", json={"content": STRATEGY})
    run = c.post("/api/runs", json={"script": "e2e.py", "symbols": ["SBIN", "TCS"], "interval": "1m"}).json()
    rid = run["id"]
    wait_for(lambda: True if c.get("/api/runs").json()[0]["state"] == "running" else None, 30)
    _wait_log(c, rid, "hello from paper")  # on_start + print() capture

    now = time.time() // 60 * 60
    _candle("SBIN", now, 820.0)
    _wait_log(c, rid, "on_order SBIN complete")
    _candle("TCS", now, 3100.0)
    _wait_log(c, rid, "tcs rsi True")
    _wait_log(c, rid, "isn't in this run's symbols")  # universe enforced, run keeps going

    logs = _logs(c, rid)
    assert "bought complete" in logs and "position delta 2" in logs
    orders = c.get("/api/orders").json()["orders"]
    mine = [o for o in orders if o["source"] == f"qvrun{rid}"]
    assert len(mine) == 1 and mine[0]["symbol"] == "SBIN" and mine[0]["quantity"] == 2
    info = next(r for r in c.get("/api/runs").json() if r["id"] == rid)
    assert info["candles"] == 2 and info["orders"] == 1 and info["errors"] == 1

    perf = c.get(f"/api/runs/{rid}/performance").json()
    s = perf["summary"]
    assert s["fills"] == 1 and s["orders"] == 1 and s["open_positions"] == 1 and s["charges"] > 0
    assert s["rejected"] == 0  # the INFY order outside the universe fails in the script, before reaching the engine
    assert perf["positions"][0]["symbol"] == "SBIN" and perf["positions"][0]["quantity"] == 2
    assert perf["fills"][0]["side"] == "BUY" and perf["trades"][0]["open"] is True
    assert perf["chart"]["symbol"] == "SBIN" and perf["chart"]["fills"] and perf["chart"]["bars"][-1]["close"] == 820.0
    assert perf["curve"] and s["net_pnl"] == pytest.approx(s["unrealized"] - s["charges"], abs=0.02)
    assert c.get(f"/api/runs/{rid}/performance", params={"symbol": "TCS"}).json()["chart"]["symbol"] == "TCS"
    assert c.get("/api/runs/nope/performance").status_code == 404

    assert c.post(f"/api/runs/{rid}/stop").status_code == 200
    wait_for(lambda: True if next(r for r in c.get("/api/runs").json() if r["id"] == rid)["state"] == "stopped" else None, 15)


def test_per_run_order_limit(signed_in):
    c = signed_in
    c.put("/api/settings/risk", json={"max_order_value": 10_000_000, "max_orders_per_minute": 100})
    c.put("/api/scripts/greedy.py", json={"content": '''
def on_candle(candle, indicators, api):
    results = [api.buy(quantity=1, order_type="LIMIT", price=1.0) for _ in range(12)]
    api.log("statuses", [o.status for o in results].count("rejected"), "rejected")
'''})
    rid = c.post("/api/runs", json={"script": "greedy.py", "symbols": ["SBIN"], "interval": "1m"}).json()["id"]
    wait_for(lambda: True if next(r for r in c.get("/api/runs").json() if r["id"] == rid)["state"] == "running" else None, 30)
    _candle("SBIN", time.time() // 60 * 60, 820.0)
    _wait_log(c, rid, "statuses 2 rejected")
    assert "limit of 10 orders per minute" in _logs(c, rid)

    # Kill switch: stops the run and cancels the 10 resting limit orders.
    result = c.post("/api/kill-switch").json()
    assert result["stopped_runs"] >= 1 and len(result["cancelled"]) >= 10 and not result["failed"]
    wait_for(lambda: True if next(r for r in c.get("/api/runs").json() if r["id"] == rid)["state"] == "stopped" else None, 15)
    assert not [o for o in c.get("/api/orders").json()["orders"] if o["is_open"]]


def test_repeated_errors_stop_the_run(signed_in):
    c = signed_in
    c.put("/api/scripts/crashy.py", json={"content": "def on_candle(candle, indicators, api):\n    raise ValueError('nope')\n"})
    rid = c.post("/api/runs", json={"script": "crashy.py", "symbols": ["SBIN"], "interval": "1m"}).json()["id"]
    wait_for(lambda: True if next(r for r in c.get("/api/runs").json() if r["id"] == rid)["state"] == "running" else None, 30)
    base = time.time() // 60 * 60
    for n in range(5):
        _candle("SBIN", base + 60 * n, 820.0)
    info = wait_for(lambda: r if (r := next(r for r in c.get("/api/runs").json() if r["id"] == rid))["state"] == "failed" else None, 20)
    assert info["errors"] == 5 and "consecutive errors" in info["message"]
    assert "ValueError: nope" in _logs(c, rid)
