"""Paper trading: orders fill against live ticks with virtual cash. Nothing is sent to a broker.

Fill rules (deliberately simple, no slippage or charges):
  MARKET  fills at the last traded price.
  LIMIT   fills at the limit price once the market trades through it.
  SL-M    becomes a market order once the trigger is hit.
  SL      becomes a limit order once the trigger is hit.
INTRADAY needs 20% of order value as margin; DELIVERY needs full cash for buys
and existing holdings for sells. State is saved to paper.json in QV_HOME.
"""

import itertools
import json
import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.broker.base import (
    Broker, BrokerError, Funds, Holding, Order, OrderChanges, OrderRequest, Position, Trade,
)
from app.market.hub import MarketHub, Tick
from app.market.instruments import Instrument, registry

log = logging.getLogger(__name__)
IST = timezone(timedelta(hours=5, minutes=30))
INTRADAY_MARGIN = 0.2


def _now() -> str:
    return datetime.now(IST).isoformat()


class PaperBroker(Broker):
    name = "paper"

    def __init__(self, hub: MarketHub, path: Path, starting_cash: float = 1_000_000.0) -> None:
        super().__init__()
        self.hub = hub
        self.path = path
        self._lock = threading.RLock()
        self._ids = itertools.count(int(time.time()))
        self.cash = starting_cash
        self._orders: dict[str, Order] = {}
        self._trades: list[Trade] = []
        self._holdings: dict[str, dict] = {}  # symbol -> {quantity, average_price}
        self._positions: dict[tuple[str, str], dict] = {}  # (symbol, product) -> buy/sell qty & value
        self._load()
        hub.add_tick_listener(self.on_tick)

    # --- persistence ----------------------------------------------------------

    def _load(self) -> None:
        try:
            state = json.loads(self.path.read_text())
        except (OSError, ValueError):
            return
        self.cash = state.get("cash", self.cash)
        self._holdings = state.get("holdings", {})
        # Orders, trades and intraday positions only live for the trading day they were made.
        if state.get("day") == datetime.now(IST).date().isoformat():
            self._orders = {o["order_id"]: Order(**{k: v for k, v in o.items() if k != "is_open"}) for o in state.get("orders", [])}
            self._trades = [Trade(**t) for t in state.get("trades", [])]
            self._positions = {(p["symbol"], p["product"]): p for p in state.get("positions", [])}

    def _save(self) -> None:
        state = {
            "day": datetime.now(IST).date().isoformat(),
            "cash": round(self.cash, 2),
            "holdings": self._holdings,
            "orders": [o.to_dict() for o in self._orders.values()],
            "trades": [t.to_dict() for t in self._trades],
            "positions": list(self._positions.values()),
        }
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1))
        tmp.replace(self.path)

    # --- queries ----------------------------------------------------------------

    def _ltp(self, symbol: str) -> float | None:
        t = self.hub.last_tick(symbol)
        return t.ltp if t else None

    def holdings(self) -> list[Holding]:
        with self._lock:
            out = []
            for sym, h in self._holdings.items():
                inst = registry.get(sym)
                tick = self.hub.last_tick(sym)
                out.append(Holding(sym, inst.exchange if inst else "NSE", h["quantity"], h["average_price"],
                                   tick.ltp if tick else None, tick.prev_close if tick else None))
            return out

    def positions(self) -> list[Position]:
        with self._lock:
            out = []
            for (sym, product), p in self._positions.items():
                buy_avg = p["buy_value"] / p["buy_quantity"] if p["buy_quantity"] else 0.0
                sell_avg = p["sell_value"] / p["sell_quantity"] if p["sell_quantity"] else 0.0
                closed = min(p["buy_quantity"], p["sell_quantity"])
                out.append(Position(sym, product, p["buy_quantity"] - p["sell_quantity"], p["buy_quantity"], p["sell_quantity"],
                                    round(buy_avg, 2), round(sell_avg, 2), self._ltp(sym), round(closed * (sell_avg - buy_avg), 2)))
            return out

    def funds(self) -> Funds:
        with self._lock:
            used = sum(abs(p["buy_quantity"] - p["sell_quantity"]) * self._position_avg(p) * INTRADAY_MARGIN
                       for (_, product), p in self._positions.items() if product == "INTRADAY")
            return Funds(available_cash=round(self.cash - used, 2), used_margin=round(used, 2), net=round(self.cash, 2))

    @staticmethod
    def _position_avg(p: dict) -> float:
        net = p["buy_quantity"] - p["sell_quantity"]
        if net > 0 and p["buy_quantity"]:
            return p["buy_value"] / p["buy_quantity"]
        if net < 0 and p["sell_quantity"]:
            return p["sell_value"] / p["sell_quantity"]
        return 0.0

    def orders(self) -> list[Order]:
        with self._lock:
            return sorted(self._orders.values(), key=lambda o: o.updated_at, reverse=True)

    def trades(self) -> list[Trade]:
        with self._lock:
            return list(reversed(self._trades))

    # --- order entry --------------------------------------------------------------

    def place_order(self, req: OrderRequest, inst: Instrument) -> Order:
        if inst.is_index:
            raise BrokerError("Indices can't be traded directly")
        ltp = self._ltp(inst.symbol)
        if ltp is None:
            raise BrokerError(f"No live price for {inst.symbol} yet; can't simulate a fill")
        with self._lock:
            ref_price = req.price or req.trigger_price or ltp
            value = ref_price * req.quantity
            self._check_funds(req, inst.symbol, value)
            order = Order(
                order_id=f"P{next(self._ids)}", symbol=inst.symbol, side=req.side, order_type=req.order_type,
                product=req.product, validity=req.validity, quantity=req.quantity, filled_quantity=0,
                price=req.price, trigger_price=req.trigger_price, average_price=None,
                status="trigger pending" if req.order_type in ("SL", "SL-M") else "open",
                message="", updated_at=_now(), variety="STOPLOSS" if req.order_type in ("SL", "SL-M") else "NORMAL",
            )
            self._orders[order.order_id] = order
            self._evaluate(order, ltp)
            if order.is_open and req.validity == "IOC":
                order.status, order.message = "cancelled", "IOC order not immediately fillable"
            self._save()
        self._emit(order)
        return order

    def _check_funds(self, req: OrderRequest, symbol: str, value: float) -> None:
        if req.product == "DELIVERY" and req.side == "BUY" and value > self.cash:
            raise BrokerError(f"Insufficient paper cash: need ₹{value:,.2f}, have ₹{self.cash:,.2f}")
        if req.product == "DELIVERY" and req.side == "SELL":
            held = self._holdings.get(symbol, {}).get("quantity", 0)
            pending = sum(o.quantity for o in self._orders.values()
                          if o.is_open and o.symbol == symbol and o.side == "SELL" and o.product == "DELIVERY")
            if req.quantity + pending > held:
                raise BrokerError(f"You hold {held} {symbol}; can't sell {req.quantity} for delivery")
        if req.product == "INTRADAY" and value * INTRADAY_MARGIN > self.funds().available_cash:
            raise BrokerError(f"Insufficient paper margin: need ₹{value * INTRADAY_MARGIN:,.2f}")

    def modify_order(self, order_id: str, changes: OrderChanges) -> Order:
        with self._lock:
            o = self._orders.get(order_id)
            if o is None or not o.is_open:
                raise BrokerError("Only open orders can be modified")
            if changes.quantity is not None:
                o.quantity = changes.quantity
            if changes.price is not None and o.order_type in ("LIMIT", "SL"):
                o.price = changes.price
            if changes.trigger_price is not None and o.order_type in ("SL", "SL-M"):
                o.trigger_price = changes.trigger_price
            o.updated_at = _now()
            ltp = self._ltp(o.symbol)
            if ltp is not None:
                self._evaluate(o, ltp)
            self._save()
        self._emit(o)
        return o

    def cancel_order(self, order_id: str) -> None:
        with self._lock:
            o = self._orders.get(order_id)
            if o is None or not o.is_open:
                raise BrokerError("Only open orders can be cancelled")
            o.status, o.updated_at = "cancelled", _now()
            self._save()
        self._emit(o)

    # --- matching ---------------------------------------------------------------

    def on_tick(self, tick: Tick) -> None:
        filled = []
        with self._lock:
            for o in list(self._orders.values()):
                if o.is_open and o.symbol == tick.symbol and self._evaluate(o, tick.ltp):
                    filled.append(o)
            if filled:
                self._save()
        for o in filled:
            self._emit(o)

    def _evaluate(self, o: Order, ltp: float) -> bool:
        """Trigger/fill `o` against `ltp`. Returns True if its state changed."""
        changed = False
        if o.status == "trigger pending":
            hit = ltp >= o.trigger_price if o.side == "BUY" else ltp <= o.trigger_price
            if not hit:
                return False
            o.status, o.updated_at, changed = "open", _now(), True
        if o.order_type in ("MARKET", "SL-M"):
            return self._fill(o, ltp)
        if o.side == "BUY" and ltp <= o.price:
            return self._fill(o, ltp)  # a marketable limit gets the better market price
        if o.side == "SELL" and ltp >= o.price:
            return self._fill(o, ltp)
        return changed

    def _fill(self, o: Order, price: float) -> bool:
        qty = o.quantity
        value = price * qty
        if o.product == "DELIVERY":
            h = self._holdings.setdefault(o.symbol, {"quantity": 0, "average_price": 0.0})
            if o.side == "BUY":
                if value > self.cash:
                    o.status, o.message = "rejected", "Insufficient paper cash at fill time"
                    return True
                self.cash -= value
                h["average_price"] = round((h["quantity"] * h["average_price"] + value) / (h["quantity"] + qty), 4)
                h["quantity"] += qty
            else:
                if h["quantity"] < qty:
                    o.status, o.message = "rejected", "Not enough holdings at fill time"
                    return True
                self.cash += value
                h["quantity"] -= qty
                if h["quantity"] == 0:
                    del self._holdings[o.symbol]
        else:
            p = self._positions.setdefault((o.symbol, o.product), {
                "symbol": o.symbol, "product": o.product, "buy_quantity": 0, "sell_quantity": 0, "buy_value": 0.0, "sell_value": 0.0,
            })
            side = "buy" if o.side == "BUY" else "sell"
            p[f"{side}_quantity"] += qty
            p[f"{side}_value"] += value
            # Cash moves by realised P&L only; margin is accounted for in funds().
            self.cash += self._realise(p, o.side, qty, price)
        o.filled_quantity, o.average_price = qty, round(price, 2)
        o.status, o.updated_at = "complete", _now()
        self._trades.append(Trade(f"T{next(self._ids)}", o.order_id, o.symbol, o.side, o.product, qty, round(price, 2), o.updated_at))
        log.info("Paper fill: %s %s x%s @ %.2f", o.side, o.symbol, qty, price)
        return True

    @staticmethod
    def _realise(p: dict, side: str, qty: int, price: float) -> float:
        """P&L realised by this fill closing part of an opposite position."""
        net_before = p["buy_quantity"] - p["sell_quantity"] + (-qty if side == "BUY" else qty)
        if side == "SELL" and net_before > 0:
            closing = min(qty, net_before)
            avg = (p["buy_value"]) / p["buy_quantity"]
            return closing * (price - avg)
        if side == "BUY" and net_before < 0:
            closing = min(qty, -net_before)
            avg = p["sell_value"] / p["sell_quantity"]
            return closing * (avg - price)
        return 0.0
