"""Angel One SmartAPI: one logged-in session shared by the market feed and the broker."""

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from app.broker.base import (
    Broker, BrokerError, Funds, Holding, Order, OrderChanges, OrderRequest, Position, Trade,
)
from app.market.instruments import Instrument, registry, symbol_key

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
# Token missing / invalid / expired: log in again and retry once.
_AUTH_ERRORS = {"AG8001", "AG8002", "AG8003"}
_MIN_CALL_SPACING = 0.35  # seconds; keeps every endpoint under Angel One's ~3 req/s floor


class AngelSession:
    def __init__(self, creds: dict) -> None:
        self.api_key: str = creds["api_key"]
        self.client_code: str = creds["client_code"]
        self._pin: str = creds["pin"]
        self._totp_secret: str = creds["totp_secret"]
        self.api = None
        self._lock = threading.RLock()
        self._last_call = 0.0

    def login(self):
        import pyotp
        from SmartApi import SmartConnect

        with self._lock:
            api = SmartConnect(api_key=self.api_key)
            try:
                res = api.generateSession(self.client_code, self._pin, pyotp.TOTP(self._totp_secret).now())
            except Exception as e:
                raise BrokerError(f"Angel One login failed: {e}") from e
            if not res or not res.get("status"):
                msg = res.get("message") if res else "no response"
                raise BrokerError(f"Angel One login failed: {msg}")
            self.api = api
            return api

    @property
    def feed_token(self) -> str:
        return self.api.getfeedToken()

    @property
    def access_token(self) -> str:
        return self.api.access_token

    def call(self, method: str, *args) -> dict:
        """Call a SmartConnect method; returns the raw response dict or raises BrokerError."""
        with self._lock:
            wait = _MIN_CALL_SPACING - (time.monotonic() - self._last_call)
            if wait > 0:
                time.sleep(wait)
            if self.api is None:
                self.login()
            for attempt in (1, 2):
                try:
                    res = self._invoke(method, *args)
                finally:
                    self._last_call = time.monotonic()
                if isinstance(res, dict) and res.get("errorcode") in _AUTH_ERRORS and attempt == 1:
                    log.info("Angel One session expired; logging in again")
                    self.login()
                    continue
                return res
        raise AssertionError("unreachable")

    def _invoke(self, method: str, *args):
        try:
            if method == "placeOrder":
                # The SDK's placeOrder drops the error message; call the endpoint directly.
                return self.api._postRequest("api.order.place", args[0])
            return getattr(self.api, method)(*args)
        except Exception as e:
            raise BrokerError(f"Angel One {method} failed: {e}") from e

    def data(self, method: str, *args):
        """Call and unwrap `data`, raising BrokerError on a failed status."""
        res = self.call(method, *args)
        if not isinstance(res, dict) or not res.get("status"):
            msg = res.get("message") if isinstance(res, dict) else str(res)
            code = res.get("errorcode") if isinstance(res, dict) else ""
            raise BrokerError(f"{msg} ({code})" if code else str(msg))
        return res.get("data")


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _i(v) -> int:
    return int(_f(v))


def _symbol(d: dict) -> str:
    exchange, ts, token = d.get("exchange", ""), d.get("tradingsymbol", ""), d.get("symboltoken", "")
    inst = registry.register(exchange, ts, token) if token else None
    return inst.symbol if inst else symbol_key(exchange, ts)


def _iso(text: str | None) -> str:
    for fmt in ("%d-%b-%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S", "%H:%M:%S"):
        try:
            dt = datetime.strptime(text or "", fmt)
            if fmt == "%H:%M:%S":
                dt = datetime.now(IST).replace(hour=dt.hour, minute=dt.minute, second=dt.second, microsecond=0)
            return dt.replace(tzinfo=IST).isoformat()
        except ValueError:
            continue
    return datetime.now(IST).isoformat()


_ORDER_TYPES = {"MARKET": "MARKET", "LIMIT": "LIMIT", "SL": "STOPLOSS_LIMIT", "SL-M": "STOPLOSS_MARKET"}
_ORDER_TYPES_BACK = {v: k for k, v in _ORDER_TYPES.items()}


class AngelBroker(Broker):
    name = "angelone"

    def __init__(self, session: AngelSession) -> None:
        super().__init__()
        self.s = session
        self._orders_cache: tuple[float, list[Order]] = (0.0, [])

    def holdings(self) -> list[Holding]:
        rows = self.s.data("holding") or []
        return [
            Holding(_symbol(d), d.get("exchange", ""), _i(d.get("quantity")) + _i(d.get("t1quantity")),
                    _f(d.get("averageprice")), _f(d.get("ltp")) or None, _f(d.get("close")) or None)
            for d in rows
        ]

    def positions(self) -> list[Position]:
        rows = self.s.data("position") or []
        out = []
        for d in rows:
            out.append(Position(
                symbol=_symbol(d),
                product=d.get("producttype", ""),
                net_quantity=_i(d.get("netqty")),
                buy_quantity=_i(d.get("buyqty")) + _i(d.get("cfbuyqty")),
                sell_quantity=_i(d.get("sellqty")) + _i(d.get("cfsellqty")),
                buy_average=_f(d.get("totalbuyavgprice") or d.get("buyavgprice")),
                sell_average=_f(d.get("totalsellavgprice") or d.get("sellavgprice")),
                ltp=_f(d.get("ltp")) or None,
                realised_pnl=_f(d.get("realised")),
            ))
        return out

    def funds(self) -> Funds:
        d = self.s.data("rmsLimit") or {}
        return Funds(available_cash=_f(d.get("availablecash")), used_margin=_f(d.get("utiliseddebits")), net=_f(d.get("net")))

    def _to_order(self, d: dict) -> Order:
        price, trigger, avg = _f(d.get("price")), _f(d.get("triggerprice")), _f(d.get("averageprice"))
        return Order(
            order_id=str(d.get("orderid", "")),
            symbol=_symbol(d),
            side=d.get("transactiontype", ""),
            order_type=_ORDER_TYPES_BACK.get(d.get("ordertype", ""), d.get("ordertype", "")),
            product=d.get("producttype", ""),
            validity=d.get("duration", ""),
            quantity=_i(d.get("quantity")),
            filled_quantity=_i(d.get("filledshares")),
            price=price or None,
            trigger_price=trigger or None,
            average_price=avg or None,
            status=(d.get("status") or d.get("orderstatus") or "").lower(),
            message=d.get("text") or "",
            updated_at=_iso(d.get("exchorderupdatetime") or d.get("updatetime")),
            variety=d.get("variety", "NORMAL"),
        )

    def orders(self) -> list[Order]:
        rows = self.s.data("orderBook") or []
        orders = [self._to_order(d) for d in rows]
        orders.sort(key=lambda o: o.updated_at, reverse=True)
        self._orders_cache = (time.monotonic(), orders)
        return orders

    def _find(self, order_id: str) -> Order:
        stamp, cached = self._orders_cache
        orders = cached if time.monotonic() - stamp < 3 else self.orders()
        for o in orders:
            if o.order_id == order_id:
                return o
        raise BrokerError(f"Order {order_id} not found in today's order book")

    def trades(self) -> list[Trade]:
        rows = self.s.data("tradeBook") or []
        trades = [
            Trade(str(d.get("fillid", "")), str(d.get("orderid", "")), _symbol(d), d.get("transactiontype", ""),
                  d.get("producttype", ""), _i(d.get("fillsize")), _f(d.get("fillprice")), _iso(d.get("filltime")))
            for d in rows
        ]
        trades.sort(key=lambda t: t.time, reverse=True)
        return trades

    def place_order(self, req: OrderRequest, inst: Instrument) -> Order:
        if inst.is_index:
            raise BrokerError("Indices can't be traded directly")
        variety = "AMO" if req.amo else ("STOPLOSS" if req.order_type in ("SL", "SL-M") else "NORMAL")
        params = {
            "variety": variety,
            "tradingsymbol": inst.trading_symbol,
            "symboltoken": inst.token,
            "transactiontype": req.side,
            "exchange": inst.exchange,
            "ordertype": _ORDER_TYPES[req.order_type],
            "producttype": req.product,
            "duration": req.validity,
            "price": str(req.price or 0),
            "triggerprice": str(req.trigger_price or 0),
            "quantity": str(req.quantity),
            "squareoff": "0",
            "stoploss": "0",
            "ordertag": "quantvision",
        }
        data = self.s.data("placeOrder", params) or {}
        order_id = str(data.get("orderid", ""))
        log.info("Angel One order placed: %s %s %s x%s -> %s", req.side, inst.symbol, req.order_type, req.quantity, order_id)
        try:
            return self._find_fresh(order_id)
        except BrokerError:
            # Accepted but not yet in the order book; report what we sent.
            return Order(order_id, inst.symbol, req.side, req.order_type, req.product, req.validity, req.quantity, 0,
                         req.price, req.trigger_price, None, "put order req received", "", datetime.now(IST).isoformat(), variety)

    def _find_fresh(self, order_id: str) -> Order:
        self._orders_cache = (0.0, [])
        return self._find(order_id)

    def modify_order(self, order_id: str, changes: OrderChanges) -> Order:
        o = self._find(order_id)
        inst = registry.get(o.symbol)
        if inst is None:
            raise BrokerError(f"Unknown instrument {o.symbol}")
        params = {
            "variety": o.variety,
            "orderid": order_id,
            "ordertype": _ORDER_TYPES.get(o.order_type, o.order_type),
            "producttype": o.product,
            "duration": o.validity,
            "price": str(changes.price if changes.price is not None else (o.price or 0)),
            "triggerprice": str(changes.trigger_price if changes.trigger_price is not None else (o.trigger_price or 0)),
            "quantity": str(changes.quantity or o.quantity),
            "tradingsymbol": inst.trading_symbol,
            "symboltoken": inst.token,
            "exchange": inst.exchange,
        }
        self.s.data("modifyOrder", params)
        return self._find_fresh(order_id)

    def cancel_order(self, order_id: str) -> None:
        o = self._find(order_id)
        self.s.data("cancelOrder", order_id, o.variety)

    def search(self, query: str) -> list[Instrument]:
        rows = self.s.data("searchScrip", "NSE", query) or []
        found: dict[str, Instrument] = {}
        for d in rows:
            ts = d.get("tradingsymbol", "")
            if ts.endswith("-EQ"):  # cash-market equities only
                inst = registry.register("NSE", ts, d.get("symboltoken", ""))
                if inst:
                    found[inst.symbol] = inst
        return list(found.values())
