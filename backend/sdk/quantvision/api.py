"""`api`: the script's only route to the broker, via the QuantVision engine."""

from collections.abc import Callable

import pandas as pd

from quantvision.models import Funds, Order


class Api:
    def __init__(self, call: Callable[[str, dict], object], log: Callable[[str, str], None], universe: list[str],
                 current: Callable[[], str], frames: Callable[[str], pd.DataFrame], mode: str) -> None:
        self._call = call
        self._log = log
        self._universe = universe
        self._current = current
        self._frames = frames
        self.mode = mode  # "paper" or "live"; follows the app's global switch

    # --- orders ------------------------------------------------------------------------

    def buy(self, quantity: int, symbol: str | None = None, order_type: str = "MARKET", price: float | None = None,
            trigger_price: float | None = None, product: str = "DELIVERY") -> Order:
        return self._order("BUY", quantity, symbol, order_type, price, trigger_price, product)

    def sell(self, quantity: int, symbol: str | None = None, order_type: str = "MARKET", price: float | None = None,
             trigger_price: float | None = None, product: str = "DELIVERY") -> Order:
        return self._order("SELL", quantity, symbol, order_type, price, trigger_price, product)

    def _order(self, side, quantity, symbol, order_type, price, trigger_price, product) -> Order:
        if not isinstance(quantity, int) or isinstance(quantity, bool) or quantity <= 0:
            raise ValueError(f"quantity must be a positive whole number, got {quantity!r}")
        result = self._call("order", {
            "side": side, "quantity": quantity, "symbol": self._resolve(symbol), "order_type": order_type.upper(),
            "price": price, "trigger_price": trigger_price, "product": product.upper(),
        })
        order = Order.from_message(result)
        if order.rejected:
            self._log("warning", f"{side} {quantity} {order.symbol} rejected: {order.message}")
        return order

    def cancel(self, order_id: str) -> None:
        self._call("cancel", {"order_id": str(order_id)})

    def cancel_all(self) -> int:
        """Cancel this run's open orders; returns how many were cancelled."""
        return int(self._call("cancel_all", {}))

    def orders(self) -> list[Order]:
        """Today's orders placed by this run."""
        return [Order.from_message(o) for o in self._call("orders", {})]

    # --- account & market ----------------------------------------------------------------

    def position(self, symbol: str | None = None) -> int:
        """Net quantity held: holdings plus today's positions (negative when short)."""
        return int(self._call("position", {"symbol": self._resolve(symbol)}))

    def funds(self) -> Funds:
        return Funds(**self._call("funds", {}))

    def ltp(self, symbol: str | None = None) -> float | None:
        value = self._call("ltp", {"symbol": self._resolve(symbol)})
        return None if value is None else float(value)

    def history(self, symbol: str | None = None, n: int = 100) -> pd.DataFrame:
        """The last n closed candles (OHLCV DataFrame, IST index)."""
        return self._frames(self._resolve(symbol)).tail(n).copy()

    def log(self, *values) -> None:
        self._log("info", " ".join(str(v) for v in values))

    # --- helpers ---------------------------------------------------------------------------

    def _resolve(self, symbol: str | None) -> str:
        sym = (symbol or self._current()).upper()
        if sym not in self._universe:
            raise ValueError(f"{sym} isn't in this run's symbols {self._universe}; add it in the Run dialog or SYMBOLS")
        return sym
