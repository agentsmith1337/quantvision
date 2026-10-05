"""How a live/paper script run is doing: its fills, positions, trades and P&L over time.

Built only from the orders the run placed (matched by its tag), so trades made by hand or by other
runs never mix in. Positions held before the run started aren't known to it. Charges are an
estimate with Angel One's tariff (the same model backtests use), since the broker reports them
only in the contract note.
"""

import threading
import time
from collections import deque
from collections.abc import Callable
from datetime import datetime, timedelta, timezone

from app.broker.base import Order
from app.market.instruments import Instrument
from app.scripts import sdk

IST = timezone(timedelta(hours=5, minutes=30))
MAX_BARS = 600  # candles kept per stock for the price chart
MAX_FILLS = 5000
MAX_CURVE = 4000


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, IST).isoformat(timespec="seconds")


class RunPerformance:
    def __init__(self, instruments: list[Instrument], ltp: Callable[[str], float | None]) -> None:
        self.universe = [i.symbol for i in instruments]
        self.exchanges = {i.symbol: i.exchange for i in instruments}
        self._ltp = ltp
        self.ledger = sdk.ledger.Ledger()
        self.fills: list[dict] = []
        self.fill_count = 0
        self.charges = 0.0
        self.turnover = 0.0
        self.orders = 0
        self.rejected = 0
        self.cancelled = 0
        self._filled: dict[str, tuple[int, float]] = {}  # order id -> (filled qty, average price) seen so far
        self._final: set[str] = set()  # orders already counted as rejected/cancelled
        self.bars: dict[str, deque] = {s: deque(maxlen=MAX_BARS) for s in self.universe}
        self.closes: dict[str, float] = {}
        self.curve: list[tuple[float, float]] = []
        self._lock = threading.RLock()

    # --- inputs ------------------------------------------------------------------------------

    def set_history(self, history: dict[str, list[dict]]) -> None:
        with self._lock:
            for sym, bars in history.items():
                for b in bars:
                    self._add_bar(sym, b)

    def on_candle(self, symbol: str, candle: dict) -> None:
        with self._lock:
            self._add_bar(symbol, candle)
            self.sample()

    def _add_bar(self, symbol: str, b: dict) -> None:
        if symbol not in self.bars:
            return
        bar = {"time": int(b["time"]), **{k: float(b[k]) for k in ("open", "high", "low", "close")}}
        q = self.bars[symbol]
        if q and q[-1]["time"] >= bar["time"]:
            if q[-1]["time"] == bar["time"]:
                q[-1] = bar
            return
        q.append(bar)
        self.closes[symbol] = bar["close"]

    def order_placed(self) -> None:
        with self._lock:
            self.orders += 1

    def order_rejected_before_broker(self) -> None:
        with self._lock:
            self.rejected += 1

    def on_order(self, order: Order) -> None:
        """An update of one of this run's orders; records whatever newly filled."""
        with self._lock:
            prev_qty, prev_avg = self._filled.get(order.order_id, (0, 0.0))
            filled = int(order.filled_quantity or 0)
            if filled > prev_qty and order.average_price:
                delta = filled - prev_qty
                # The average covers every fill so far; recover this slice's price from it.
                price = (order.average_price * filled - prev_avg * prev_qty) / delta
                self._filled[order.order_id] = (filled, float(order.average_price))
                self._record_fill(order, delta, price)
            if order.status in ("rejected", "cancelled") and order.order_id not in self._final:
                self._final.add(order.order_id)
                if order.status == "rejected":
                    self.rejected += 1
                else:
                    self.cancelled += 1

    def _record_fill(self, order: Order, qty: int, price: float) -> None:
        sym = order.symbol
        ch = sdk.charges.compute(order.side, order.product, price, qty, self.exchanges.get(sym, "NSE"))
        when = order.updated_at or _iso(time.time())
        self.charges += ch.total
        self.turnover += price * qty
        self.ledger.fill(sym, order.product, order.side, qty, price, ch.total, when)
        self.fill_count += 1
        if len(self.fills) < MAX_FILLS:
            self.fills.append({
                "time": when, "order_id": order.order_id, "symbol": sym, "side": order.side, "product": order.product,
                "order_type": order.order_type, "quantity": qty, "price": round(price, 4), "value": round(price * qty, 2),
                "charges": round(ch.total, 2), "auto": False, "placed": None,
            })
        self.sample()

    # --- derived -------------------------------------------------------------------------------

    def prices(self) -> dict[str, float]:
        out = dict(self.closes)
        for sym in self.universe:
            try:
                ltp = self._ltp(sym)
            except Exception:  # noqa: BLE001 - a price lookup must never break the run
                ltp = None
            if ltp:
                out[sym] = float(ltp)
        return out

    def pnl(self, prices: dict[str, float] | None = None) -> float:
        prices = self.prices() if prices is None else prices
        return self.ledger.realized() + self.ledger.unrealized(prices) - self.charges

    def sample(self) -> None:
        """Add a point to the P&L curve (at most one per second)."""
        with self._lock:
            now, value = time.time(), self.pnl()
            if self.curve and now - self.curve[-1][0] < 1:
                self.curve[-1] = (self.curve[-1][0], value)
            else:
                self.curve.append((now, value))
            if len(self.curve) > MAX_CURVE:  # thin the older half, keep recent detail
                half = len(self.curve) // 2
                self.curve = self.curve[:half:2] + self.curve[half:]

    def snapshot(self, symbol: str | None = None) -> dict:
        with self._lock:
            prices = self.prices()
            now = time.time()
            closed = list(self.ledger.trades)
            open_trades = self.ledger.open_trades(prices, _iso(now))
            realized = self.ledger.realized()
            unrealized = self.ledger.unrealized(prices)
            net = realized + unrealized - self.charges
            points = [*self.curve, (now, net)] if not self.curve or now - self.curve[-1][0] >= 1 else self.curve
            peak, worst, curve = 0.0, 0.0, []
            for t, v in points:
                peak = max(peak, v)
                worst = min(worst, v - peak)
                curve.append({"time": _iso(t), "pnl": round(v, 2), "drawdown": round(v - peak, 2)})
            summary = {
                "net_pnl": round(net, 2), "realized": round(realized, 2), "unrealized": round(unrealized, 2),
                "charges": round(self.charges, 2), "turnover": round(self.turnover, 2), "max_drawdown": round(worst, 2),
                "orders": self.orders, "rejected": self.rejected, "cancelled": self.cancelled, "fills": self.fill_count,
                "open_positions": sum(1 for b in self.ledger.books.values() if b.qty),
                **sdk.ledger.trade_stats(closed),
            }
            per_symbol = []
            for sym in self.universe:
                mine = [t for t in closed if t["symbol"] == sym]
                opened = [t for t in open_trades if t["symbol"] == sym]
                if mine or opened:
                    wins = sum(1 for t in mine if t["net_pnl"] > 0)
                    per_symbol.append({
                        "symbol": sym, "trades": len(mine), "net_pnl": round(sum(t["net_pnl"] for t in mine), 2),
                        "win_rate_pct": round(wins / len(mine) * 100, 2) if mine else None,
                        "open_pnl": round(sum(t["net_pnl"] for t in opened), 2),
                    })
            traded = [p["symbol"] for p in per_symbol]
            chart = (symbol or "").upper()
            if chart not in self.bars:
                chart = traded[0] if traded else (self.universe[0] if self.universe else "")
            return {
                "summary": summary,
                "curve": curve,
                "positions": self.ledger.positions(prices),
                "trades": closed + open_trades,
                "fills": list(self.fills),
                "fills_truncated": self.fill_count > len(self.fills),
                "per_symbol": per_symbol,
                "chart": {
                    "symbol": chart,
                    "bars": list(self.bars.get(chart, [])),
                    "fills": [f for f in self.fills if f["symbol"] == chart],
                    "position": next(({"quantity": b.qty, "average_price": round(b.avg, 4), "product": p}
                                      for (s, p), b in self.ledger.books.items() if s == chart and b.qty), None),
                    "ltp": prices.get(chart),
                },
                "symbols": self.universe,
                "as_of": _iso(now),
            }
