"""Unit tests for paper-trading fills, driven by hand-fed ticks."""

import time

import pytest

from app.broker.base import BrokerError, OrderRequest
from app.broker.paper import PaperBroker
from app.market.hub import MarketHub, Tick
from app.market.instruments import registry

SBIN = registry.get("SBIN")


@pytest.fixture
def setup(tmp_path):
    hub = MarketHub()
    broker = PaperBroker(hub, tmp_path / "paper.json", starting_cash=100_000)
    events = []
    broker.on_order_update(events.append)

    def tick(price: float) -> None:
        hub.publish(Tick("SBIN", price, int(time.time() * 1000), prev_close=800.0))

    tick(800.0)
    return broker, tick, events, tmp_path


def order(**kw) -> OrderRequest:
    return OrderRequest(symbol="SBIN", **{"side": "BUY", "quantity": 10, **kw})


def test_resting_limit_fills_when_market_trades_through(setup):
    broker, tick, events, _ = setup
    o = broker.place_order(order(order_type="LIMIT", price=790), SBIN)
    assert o.status == "open"
    tick(795)
    assert o.status == "open"
    tick(788.5)
    assert o.status == "complete" and o.average_price == 788.5  # better than the limit
    assert broker.funds().available_cash == pytest.approx(100_000 - 7885)
    assert [e.status for e in events] == ["open", "complete"]


def test_stop_market_sell_triggers_on_the_way_down(setup):
    broker, tick, _, _ = setup
    broker.place_order(order(), SBIN)  # own 10 @ 800
    stop = broker.place_order(order(side="SELL", order_type="SL-M", trigger_price=780), SBIN)
    assert stop.status == "trigger pending"
    tick(781)
    assert stop.status == "trigger pending"
    tick(779)
    assert stop.status == "complete" and stop.average_price == 779
    assert broker.holdings() == []


def test_stop_limit_buy_waits_for_its_limit_after_triggering(setup):
    broker, tick, events, _ = setup
    o = broker.place_order(order(order_type="SL", trigger_price=810, price=812), SBIN)
    tick(811)  # triggered, becomes a limit buy at 812 -> marketable at 811
    assert o.status == "complete" and o.average_price == 811
    events.clear()
    o2 = broker.place_order(order(order_type="SL", trigger_price=815, price=815), SBIN)
    tick(816)  # triggered but 816 > 815 limit: rests as open
    assert o2.status == "open"
    n = len(events)
    tick(816.5)  # still unfillable: must not re-report a change every tick
    assert len(events) == n


def test_intraday_round_trip_realises_pnl_and_releases_margin(setup):
    broker, tick, _, _ = setup
    broker.place_order(order(product="INTRADAY", quantity=100), SBIN)
    funds = broker.funds()
    assert funds.used_margin == pytest.approx(100 * 800 * 0.2)
    assert funds.available_cash == pytest.approx(100_000 - 16_000)
    tick(810)
    broker.place_order(order(side="SELL", product="INTRADAY", quantity=100), SBIN)
    funds = broker.funds()
    assert funds.used_margin == 0
    assert funds.available_cash == pytest.approx(100_000 + 1000)
    (pos,) = broker.positions()
    assert pos.net_quantity == 0 and pos.realised_pnl == pytest.approx(1000)


def test_ioc_cancels_when_not_immediately_fillable(setup):
    broker, _, _, _ = setup
    o = broker.place_order(order(order_type="LIMIT", price=700, validity="IOC"), SBIN)
    assert o.status == "cancelled"


def test_insufficient_cash_rejected(setup):
    broker, _, _, _ = setup
    with pytest.raises(BrokerError, match="Insufficient paper cash"):
        broker.place_order(order(quantity=200), SBIN)  # 160,000 > 100,000


def test_state_survives_restart(setup):
    broker, _, _, tmp_path = setup
    broker.place_order(order(), SBIN)
    reloaded = PaperBroker(MarketHub(), tmp_path / "paper.json", starting_cash=100_000)
    assert [(h.symbol, h.quantity) for h in reloaded.holdings()] == [("SBIN", 10)]
    assert reloaded.funds().available_cash == pytest.approx(92_000)
    assert len(reloaded.orders()) == 1
