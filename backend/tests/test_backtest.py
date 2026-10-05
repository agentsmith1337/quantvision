"""Backtests: charges, the Parquet history cache, and full runs through the API (Yahoo mocked)."""

import sys
import zlib
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from app.backtest import data as data_mod
from app.backtest.data import DataError, HistoryCache, missing_ranges, validate_range, yahoo_ticker
from app.market.instruments import Instrument
from tests.conftest import signin, wait_for

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk"))
from quantvision import charges  # noqa: E402

TODAY = data_mod.today_ist()


# --- charges ----------------------------------------------------------------------------------


def test_angel_one_charges():
    buy = charges.compute("BUY", "DELIVERY", 1000.0, 100)  # Rs 1,00,000 turnover
    assert buy.brokerage == 20  # 0.1% would be 100; capped at 20
    assert buy.stt == pytest.approx(100)
    assert buy.stamp == pytest.approx(15)
    assert buy.dp == 0
    assert buy.exchange == pytest.approx(100_000 * (0.0030699 + 0.0001) / 100)
    assert buy.gst == pytest.approx((buy.brokerage + buy.exchange + buy.sebi) * 0.18)
    sell = charges.compute("SELL", "DELIVERY", 1000.0, 100)
    assert sell.stamp == 0 and sell.dp == 20 and sell.stt == pytest.approx(100)
    tiny = charges.compute("BUY", "INTRADAY", 100.0, 10)  # Rs 1,000: 0.1% = 1, minimum 5
    assert tiny.brokerage == 5 and tiny.stt == 0 and tiny.stamp == pytest.approx(0.03)
    assert charges.compute("SELL", "INTRADAY", 1000.0, 100).stt == pytest.approx(25)
    assert charges.compute("BUY", "DELIVERY", 1000.0, 100, cfg=charges.config({"brokerage_max": 0, "brokerage_min": 0, "bogus": 5})).brokerage == 0
    assert charges.config({"stt_delivery_pct": -1})["stt_delivery_pct"] == 0.1  # negative values ignored


# --- data ---------------------------------------------------------------------------------------


def test_yahoo_tickers():
    assert yahoo_ticker(Instrument("RELIANCE", "Reliance Industries", "NSE", "2885", "RELIANCE-EQ")) == "RELIANCE.NS"
    assert yahoo_ticker(Instrument("BSE:RELIANCE", "Reliance Industries", "BSE", "500325", "RELIANCE")) == "RELIANCE.BO"
    assert yahoo_ticker(Instrument("NIFTY", "Nifty 50", "NSE", "99926000", "Nifty 50", is_index=True)) == "^NSEI"
    assert yahoo_ticker(Instrument("NSE:NIFTY IT", "Nifty IT", "NSE", "1", "Nifty IT", is_index=True)) == "^CNXIT"
    with pytest.raises(DataError):
        yahoo_ticker(Instrument("NSE:NIFTY XYZ", "Nifty XYZ", "NSE", "1", "Nifty XYZ", is_index=True))


def test_missing_ranges_and_limits():
    d = date.fromisoformat
    covered = [[d("2024-01-01"), d("2024-01-31")], [d("2024-03-01"), d("2024-03-31")]]
    assert missing_ranges(covered, d("2024-01-10"), d("2024-03-10")) == [(d("2024-02-01"), d("2024-02-29"))]
    assert missing_ranges(covered, d("2023-12-01"), d("2024-04-05")) == [
        (d("2023-12-01"), d("2023-12-31")), (d("2024-02-01"), d("2024-02-29")), (d("2024-04-01"), d("2024-04-05"))]
    assert missing_ranges([], d("2024-01-01"), d("2024-01-02")) == [(d("2024-01-01"), d("2024-01-02"))]
    validate_range("1d", d("2005-01-01"), TODAY)
    with pytest.raises(DataError, match="last 60 days"):
        validate_range("5m", TODAY - timedelta(days=90), TODAY)
    with pytest.raises(DataError, match="before"):
        validate_range("1d", d("2024-02-01"), d("2024-01-01"))


def synthetic(ticker: str, interval: str, start: date, end: date) -> pd.DataFrame:
    """Yahoo-shaped candles in [start, end): a random walk that's the same for the same ticker and day."""
    days = [d for d in pd.date_range(start, end - timedelta(days=1), freq="D") if d.weekday() < 5]
    rows, idx = [], []
    for day in days:
        rng = np.random.default_rng(zlib.crc32(f"{ticker}{day.date()}".encode()))
        base = 500 + (day.toordinal() % 97) + (zlib.crc32(ticker.encode()) % 300)
        if interval == "1d":
            times = [day.tz_localize("Asia/Kolkata")]
        else:
            step = {"1h": 60, "15m": 15, "5m": 5, "1m": 1}[interval]
            times = list(pd.date_range(day + pd.Timedelta(hours=9, minutes=15), day + pd.Timedelta(hours=15, minutes=29), freq=f"{step}min", tz="Asia/Kolkata"))
        price = base
        for t in times:
            o = price + rng.normal(0, 1)
            c = o + rng.normal(0, 2)
            rows.append([o, max(o, c) + 1, min(o, c) - 1, c, c, 1000 + int(rng.integers(0, 500))])
            idx.append(t)
            price = c
    return pd.DataFrame(rows, columns=["Open", "High", "Low", "Close", "Adj Close", "Volume"], index=pd.DatetimeIndex(idx))


@pytest.fixture
def yahoo(monkeypatch):
    calls = []

    def fake(ticker, interval, start, end):
        calls.append((ticker, interval, start, end))
        return synthetic(ticker, interval, start, end)

    monkeypatch.setattr(data_mod, "_download", fake)
    return calls


def test_history_cache_downloads_only_whats_missing(tmp_path, yahoo):
    cache = HistoryCache(tmp_path)
    d = date.fromisoformat
    first = cache.candles("SBIN.NS", "1d", d("2024-01-01"), d("2024-03-31"))
    assert len(yahoo) == 1 and len(first) > 50
    assert first.index[0].hour == 9 and first.index[0].minute == 15 and str(first.index.tz) in ("Asia/Kolkata", "UTC+05:30")
    assert list(first.columns) == ["open", "high", "low", "close", "volume"]
    again = cache.candles("SBIN.NS", "1d", d("2024-02-01"), d("2024-02-29"))
    assert len(yahoo) == 1 and again.index.min() >= pd.Timestamp("2024-02-01", tz="Asia/Kolkata")
    cache.candles("SBIN.NS", "1d", d("2023-12-01"), d("2024-04-30"))
    assert [(c[2], c[3]) for c in yahoo[1:]] == [(d("2023-12-01"), d("2024-01-01")), (d("2024-04-01"), d("2024-05-01"))]
    assert (tmp_path / "SBIN.NS_1d.parquet").exists() and (tmp_path / "SBIN.NS_1d.json").exists()
    # Today is never marked as downloaded: the day's candles may still change.
    cache.candles("SBIN.NS", "5m", TODAY - timedelta(days=3), TODAY)
    n = len(yahoo)
    cache.candles("SBIN.NS", "5m", TODAY - timedelta(days=3), TODAY)
    assert len(yahoo) == n + 1 and yahoo[-1][2] == TODAY


# --- full backtests --------------------------------------------------------------------------------

CROSSOVER = '''
SYMBOLS = ["SBIN", "RELIANCE"]
seen = []

def on_start(api):
    print("mode", api.mode, api.funds().available_cash)

def on_candle(candle, indicators, api):
    df = indicators.df()
    assert df.index[-1] == candle.time and df["close"].iloc[-1] == candle.close   # no future candles
    seen.append(candle.symbol)
    fast, slow = indicators.series("ema", period=5), indicators.series("ema", period=20)
    if indicators.crossed_above(fast, slow) and api.position() == 0:
        o = api.buy(quantity=10)
        api.log("placed", candle.symbol, candle.time.date(), "close", candle.close, o.status)
    elif indicators.crossed_below(fast, slow) and api.position() > 0:
        api.sell(quantity=api.position())
    if candle.symbol == "SBIN" and seen.count("SBIN") == 1:
        r = api.sell(quantity=5000)
        api.log("oversell", r.status, r.message)

def on_order(order, api):
    api.log("filled", order.symbol, order.side, order.status, order.average_price)

def on_stop(api):
    print("candles seen", len(seen))
'''

INTRADAY = '''
def on_candle(candle, indicators, api):
    t = candle.time.strftime("%H:%M")
    if t == "10:00" and api.position() == 0:
        api.sell(quantity=20, product="INTRADAY")     # short; never covered by the script
    if t == "15:20":
        api.log("after square-off position", api.position())
'''


@pytest.fixture
def signed_in(client, yahoo):
    signin(client)
    return client


def _run(c, script: str, code: str, **body) -> dict:
    assert c.put(f"/api/scripts/{script}", json={"content": code}).status_code == 200
    r = c.post("/api/backtests", json={"script": script, **body})
    assert r.status_code == 200, r.text
    bid = r.json()["id"]
    wait_for(lambda: True if c.get(f"/api/backtests/{bid}").json()["info"]["state"] not in ("preparing", "running") else None, 120)
    return c.get(f"/api/backtests/{bid}").json()


def test_config_endpoint(signed_in):
    cfg = signed_in.get("/api/backtests/config").json()
    assert cfg["charges"]["brokerage_max"] == 20 and cfg["intervals"]["1d"]["earliest"] is None
    assert cfg["intervals"]["5m"]["earliest"] == (TODAY - timedelta(days=59)).isoformat()


def test_daily_backtest_end_to_end(signed_in):
    c = signed_in
    out = _run(c, "bt_cross.py", CROSSOVER, symbols=["SBIN", "RELIANCE"], interval="1d",
               start="2024-01-01", end="2024-12-31", capital=500000, slippage_pct=0)
    info, result = out["info"], out["result"]
    assert info["state"] == "done", (info, out["logs"][-5:])
    logs = "\n".join(l["text"] for l in out["logs"])
    assert "mode backtest 500000.0" in logs and "candles seen" in logs
    assert "oversell rejected Not enough holdings" in logs
    s = result["summary"]
    assert s["candles"] > 200 and s["trades"] >= 1 and s["fills"] >= 2 and s["total_charges"] > 0
    assert s["final_value"] == pytest.approx(500000 + sum(t["net_pnl"] for t in result["trades"]), abs=0.05)
    assert result["equity"][0]["equity"] == 500000 and result["equity"][-1]["benchmark"] is not None
    # Market orders fill at the next candle's open (no slippage here).
    frames = {s: data_mod.normalise(synthetic(t, "1d", date(2023, 1, 1), date(2025, 1, 1)), "1d")
              for s, t in (("SBIN", "SBIN.NS"), ("RELIANCE", "RELIANCE.NS"))}
    for f in result["fills"][:6]:
        bar = frames[f["symbol"]].loc[pd.Timestamp(f["time"])]
        assert f["price"] == pytest.approx(bar["open"], abs=1e-3)
        assert pd.Timestamp(f["time"]) > pd.Timestamp(f["placed"])
    assert info["summary"]["trades"] == s["trades"]
    assert info["charges"] == {}  # defaults kept: nothing stored as custom
    listed = c.get("/api/backtests", params={"script": "bt_cross.py"}).json()
    assert listed[0]["id"] == info["id"]
    assert c.get(f"/api/backtests/{info['id']}").json()["code"] == CROSSOVER


def test_intraday_square_off(signed_in):
    out = _run(signed_in, "bt_intraday.py", INTRADAY, symbols=["SBIN"], interval="5m",
               start=(TODAY - timedelta(days=10)).isoformat(), end=(TODAY - timedelta(days=1)).isoformat(), capital=200000)
    assert out["info"]["state"] == "done", out["logs"][-5:]
    r = out["result"]
    autos = [f for f in r["fills"] if f["auto"]]
    assert autos and all(f["time"][11:16] == "15:15" and f["side"] == "BUY" for f in autos)
    assert all(t["product"] == "INTRADAY" and t["direction"] == "short" and not t["open"] for t in r["trades"])
    logs = "\n".join(l["text"] for l in out["logs"])
    assert "after square-off position 0" in logs and "Auto square-off" in logs


def test_validation_errors_and_failures(signed_in):
    c = signed_in
    c.put("/api/scripts/bt_cross.py", json={"content": CROSSOVER})
    bad = lambda **kw: c.post("/api/backtests", json={"script": "bt_cross.py", "symbols": ["SBIN"], "interval": "1d", "start": "2024-01-01", "end": "2024-06-30", **kw})  # noqa: E731
    assert "last 60 days" in bad(interval="5m").json()["detail"]
    assert bad(symbols=["NOPE"]).status_code == 400
    assert "indices" in bad(symbols=["NIFTY"]).json()["detail"]
    assert bad(capital=10).status_code == 400
    c.put("/api/scripts/bt_broken.py", json={"content": "def on_candle(c, i, a):\n    raise ValueError('boom')\n"})
    out = _run(c, "bt_broken.py", "def on_candle(c, i, a):\n    raise ValueError('boom')\n", symbols=["SBIN"], interval="1d", start="2024-01-01", end="2024-03-31")
    assert out["info"]["state"] == "error" and "5 consecutive errors" in out["info"]["message"]
    assert "boom" in "\n".join(l["text"] for l in out["logs"])
    bid = out["info"]["id"]
    assert c.delete(f"/api/backtests/{bid}").status_code == 200
    assert c.get(f"/api/backtests/{bid}").status_code == 404


def test_cancel(signed_in):
    c = signed_in
    slow = "import time\ndef on_candle(candle, indicators, api):\n    time.sleep(0.05)\n"
    c.put("/api/scripts/bt_slow.py", json={"content": slow})
    bid = c.post("/api/backtests", json={"script": "bt_slow.py", "symbols": ["SBIN"], "interval": "1d", "start": "2015-01-01", "end": "2024-12-31"}).json()["id"]
    wait_for(lambda: True if c.get(f"/api/backtests/{bid}").json()["info"]["state"] == "running" else None, 60)
    busy = c.post("/api/backtests", json={"script": "bt_slow.py", "symbols": ["SBIN"], "interval": "1d", "start": "2024-01-01", "end": "2024-02-01"})
    assert busy.status_code == 400 and "Another backtest" in busy.json()["detail"]
    assert c.post(f"/api/backtests/{bid}/cancel").status_code == 200
    wait_for(lambda: True if c.get(f"/api/backtests/{bid}").json()["info"]["state"] == "cancelled" else None, 30)
