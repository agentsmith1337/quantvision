"""Round-trip trade bookkeeping shared by backtests and live runs.

Pure Python (no QuantVision imports), so the engine can load this file directly too.
A Ledger tracks each stock's position per product (DELIVERY / INTRADAY) from fills, and turns
every position that opens and returns to zero into one trade row with its P&L and charges.
"""

from dataclasses import dataclass, field


@dataclass
class Book:
    """One stock's position in one product, with the round trip it belongs to."""

    qty: int = 0
    avg: float = 0.0
    trade: dict | None = None


@dataclass
class Ledger:
    trades: list[dict] = field(default_factory=list)
    books: dict = field(default_factory=dict)  # (symbol, product) -> Book

    def book(self, symbol: str, product: str) -> Book:
        return self.books.setdefault((symbol, product), Book())

    def qty(self, symbol: str, product: str) -> int:
        b = self.books.get((symbol, product))
        return b.qty if b else 0

    def fill(self, symbol: str, product: str, side: str, qty: int, price: float, charges: float, when: str) -> None:
        b = self.book(symbol, product)
        signed = qty if side == "BUY" else -qty
        remaining = qty
        if b.qty and (b.qty > 0) != (signed > 0):  # reduces (or flips) the position
            closing = min(qty, abs(b.qty))
            t = b.trade
            t["exit_qty"] += closing
            t["exit_value"] += closing * price
            t["gross_pnl"] += closing * (price - b.avg) * (1 if b.qty > 0 else -1)
            t["charges"] += charges * closing / qty
            b.qty += closing if signed > 0 else -closing
            if b.qty == 0:
                self._close(t, when)
                b.trade, b.avg = None, 0.0
            remaining = qty - closing
        if remaining:
            part = charges * remaining / qty
            if b.qty == 0:
                b.trade = {
                    "symbol": symbol, "product": product, "direction": "long" if signed > 0 else "short",
                    "entry_time": when, "entry_qty": 0, "entry_value": 0.0, "exit_qty": 0, "exit_value": 0.0,
                    "gross_pnl": 0.0, "charges": 0.0, "max_qty": 0,
                }
            b.avg = (b.avg * abs(b.qty) + price * remaining) / (abs(b.qty) + remaining)
            b.qty += remaining if signed > 0 else -remaining
            t = b.trade
            t["entry_qty"] += remaining
            t["entry_value"] += remaining * price
            t["charges"] += part
            t["max_qty"] = max(t["max_qty"], abs(b.qty))

    def _close(self, t: dict, when: str) -> None:
        self.trades.append(trade_row(t, when, t["exit_value"] / t["exit_qty"], closed=True))

    def positions(self, last_price: dict[str, float]) -> list[dict]:
        """Open positions with their mark-to-market P&L (None where no price is known)."""
        rows = []
        for (sym, product), b in self.books.items():
            if b.qty:
                ltp = last_price.get(sym)
                rows.append({
                    "symbol": sym, "product": product, "quantity": b.qty, "average_price": round(b.avg, 4), "ltp": ltp,
                    "unrealized": round(b.qty * (ltp - b.avg), 2) if ltp is not None else None,
                })
        return rows

    def realized(self) -> float:
        """Gross P&L of closed trades plus the closed part of open ones (charges not deducted)."""
        open_part = sum(b.trade["gross_pnl"] for b in self.books.values() if b.qty and b.trade)
        return sum(t["gross_pnl"] for t in self.trades) + open_part

    def unrealized(self, last_price: dict[str, float]) -> float:
        return sum(b.qty * (last_price[s] - b.avg) for (s, _), b in self.books.items() if b.qty and s in last_price)

    def open_trades(self, last_price: dict[str, float], when: str) -> list[dict]:
        rows = []
        for (sym, _), b in self.books.items():
            if b.qty and b.trade and sym in last_price:
                t = dict(b.trade)
                t["gross_pnl"] += abs(b.qty) * (last_price[sym] - b.avg) * (1 if b.qty > 0 else -1)
                rows.append(trade_row(t, when, last_price[sym], closed=False))
        return rows


def trade_row(t: dict, when: str, exit_price: float, closed: bool) -> dict:
    entry_price = t["entry_value"] / t["entry_qty"]
    net = t["gross_pnl"] - t["charges"]
    return {
        "symbol": t["symbol"], "product": t["product"], "direction": t["direction"], "quantity": t["max_qty"],
        "entry_time": t["entry_time"], "entry_price": round(entry_price, 4),
        "exit_time": when, "exit_price": round(exit_price, 4),
        "gross_pnl": round(t["gross_pnl"], 2), "charges": round(t["charges"], 2), "net_pnl": round(net, 2),
        "return_pct": round(net / (entry_price * t["max_qty"]) * 100, 3) if entry_price and t["max_qty"] else 0.0,
        "open": not closed,
    }


def trade_stats(trades: list[dict]) -> dict:
    if not trades:
        return {"trades": 0, "win_rate_pct": None, "profit_factor": None, "avg_trade_pnl": None,
                "avg_win": None, "avg_loss": None, "best_trade": None, "worst_trade": None}
    pnl = [t["net_pnl"] for t in trades]
    wins, losses = [p for p in pnl if p > 0], [p for p in pnl if p <= 0]
    return {
        "trades": len(trades),
        "win_rate_pct": round(len(wins) / len(trades) * 100, 2),
        "profit_factor": round(sum(wins) / -sum(losses), 3) if losses and sum(losses) < 0 else None,
        "avg_trade_pnl": round(sum(pnl) / len(pnl), 2),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "best_trade": round(max(pnl), 2), "worst_trade": round(min(pnl), 2),
    }
