"""Live-run performance tracking: fills from order updates, round trips, P&L and charges."""

from dataclasses import replace

import pytest

from app.broker.base import Order
from app.market.instruments import Instrument
from app.scripts.performance import RunPerformance

SBIN = Instrument("SBIN", "State Bank of India", "NSE", "3045", "SBIN-EQ")
TCS = Instrument("TCS", "Tata Consultancy Services", "NSE", "11536", "TCS-EQ")


def order(oid: str, side: str, qty: int, filled: int, avg: float | None, status: str, symbol: str = "SBIN", product: str = "INTRADAY") -> Order:
    return Order(order_id=oid, symbol=symbol, side=side, order_type="MARKET", product=product, quantity=qty, filled_quantity=filled,
                 price=None, trigger_price=None, average_price=avg, status=status, message="", updated_at="2026-10-05T10:00:00+05:30", validity="DAY",
                 source="qvrunabc")


def test_partial_fills_round_trip_and_pnl():
    ltp = {"SBIN": 810.0}
    perf = RunPerformance([SBIN, TCS], lambda s: ltp.get(s))
    perf.set_history({"SBIN": [{"time": 1, "open": 800, "high": 801, "low": 799, "close": 800, "volume": 1}]})
    perf.order_placed()
    buy = order("1", "BUY", 10, 4, 800.0, "open")
    perf.on_order(buy)
    perf.on_order(buy)  # repeated update: nothing new filled
    perf.on_order(replace(buy, filled_quantity=10, average_price=802.4, status="complete"))  # 6 more @ 804
    assert [f["quantity"] for f in perf.fills] == [4, 6]
    assert perf.fills[1]["price"] == pytest.approx(804.0)

    snap = perf.snapshot()
    assert snap["positions"][0]["quantity"] == 10 and snap["positions"][0]["average_price"] == pytest.approx(802.4)
    assert snap["summary"]["unrealized"] == pytest.approx(10 * (810 - 802.4))
    assert snap["trades"][0]["open"] is True

    perf.order_placed()
    perf.on_order(order("2", "SELL", 10, 10, 815.0, "complete"))
    snap = perf.snapshot()
    s = snap["summary"]
    assert s["trades"] == 1 and s["open_positions"] == 0 and s["unrealized"] == 0
    assert s["realized"] == pytest.approx(10 * (815 - 802.4))
    assert s["net_pnl"] == pytest.approx(s["realized"] - s["charges"], abs=0.01)
    assert snap["trades"][0]["net_pnl"] == pytest.approx(s["net_pnl"], abs=0.02)
    assert snap["per_symbol"][0]["symbol"] == "SBIN" and snap["summary"]["fills"] == 3

    perf.on_order(order("3", "BUY", 5, 0, None, "rejected", symbol="TCS"))
    perf.on_order(order("3", "BUY", 5, 0, None, "rejected", symbol="TCS"))
    perf.order_rejected_before_broker()
    assert perf.snapshot()["summary"]["rejected"] == 2


def test_chart_defaults_to_a_traded_stock_and_keeps_candles_in_order():
    perf = RunPerformance([SBIN, TCS], lambda s: None)
    perf.on_candle("TCS", {"time": 120, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 0})
    perf.on_candle("TCS", {"time": 60, "open": 1, "high": 2, "low": 1, "close": 1.5, "volume": 0})  # older: ignored
    perf.on_order(order("9", "BUY", 1, 1, 3000.0, "complete", symbol="TCS", product="DELIVERY"))
    snap = perf.snapshot()
    assert snap["chart"]["symbol"] == "TCS" and [b["time"] for b in snap["chart"]["bars"]] == [120]
    assert snap["chart"]["position"]["quantity"] == 1
    assert perf.snapshot("SBIN")["chart"]["symbol"] == "SBIN"
