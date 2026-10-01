"""Angel One SmartAPI: one logged-in session shared by the market feed and the broker."""

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from app.broker.base import (
    Broker, BrokerError, Funds, Holding, Order, OrderChanges, OrderRequest, Position, Trade,
)
from app.broker.ratelimit import RateLimiter
from app.market.instruments import Instrument, registry, symbol_key

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
# Token missing / invalid / expired: log in again and retry once.
_AUTH_ERRORS = {"AG8001", "AG8002", "AG8003"}
_RATE_LIMIT_RETRIES = 3
RATE_LIMITED = "Angel One is rate-limiting requests; try again in a few seconds"


def _is_rate_limited(payload) -> bool:
    text = str(payload).lower()
    return "access rate" in text or "too many requests" in text or "rate limit" in text


class AngelSession:
    def __init__(self, creds: dict) -> None:
        self.api_key: str = creds["api_key"]
        self.client_code: str = creds["client_code"]
        self._pin: str = creds["pin"]
        self._totp_secret: str = creds["totp_secret"]
        self.api = None
        self._login_lock = threading.RLock()
        self.limiter = RateLimiter()

    def login(self):
        import pyotp
        from SmartApi import SmartConnect

        with self._login_lock:
            self.limiter.acquire("generateSession")
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

    def call(self, method: str, *args, abort: threading.Event | None = None) -> dict:
        """Call a SmartConnect method within its rate limit; returns the raw response.

        Raises BrokerError on failure, or ratelimit.Cancelled if `abort` is set while waiting.
        """
        if self.api is None:
            self.login()
        relogged = False
        for attempt in range(_RATE_LIMIT_RETRIES + 1):
            self.limiter.acquire(method, abort)
            try:
                res = self._invoke(method, *args)
            except BrokerError as e:
                if not _is_rate_limited(e):
                    raise
                if attempt == _RATE_LIMIT_RETRIES:
                    raise BrokerError(RATE_LIMITED) from e
                self._back_off(method, attempt)
                continue
            if isinstance(res, dict) and res.get("errorcode") in _AUTH_ERRORS and not relogged:
                log.info("Angel One session expired; logging in again")
                self.login()
                relogged = True
                continue
            if isinstance(res, dict) and not res.get("status") and _is_rate_limited(res.get("message")):
                if attempt == _RATE_LIMIT_RETRIES:
                    raise BrokerError(RATE_LIMITED)
                self._back_off(method, attempt)
                continue
            return res
        raise BrokerError(RATE_LIMITED)

    def _back_off(self, method: str, attempt: int) -> None:
        delay = 1.0 * (2**attempt)
        log.info("Angel One rate limit hit on %s; retrying in %.0fs", method, delay)
        self.limiter.penalise(method, delay)

    def _invoke(self, method: str, *args):
        try:
            if method == "placeOrder":
                # The SDK's placeOrder drops the error message; call the endpoint directly.
                return self.api._postRequest("api.order.place", args[0])
            return getattr(self.api, method)(*args)
        except Exception as e:
            raise BrokerError(f"Angel One {method} failed: {e}") from e

    def data(self, method: str, *args, abort: threading.Event | None = None):
        """Call and unwrap `data`, raising BrokerError on a failed status."""
        res = self.call(method, *args, abort=abort)
        if not isinstance(res, dict) or not res.get("status"):
            msg = res.get("message") if isinstance(res, dict) else str(res)
            code = res.get("errorcode") if isinstance(res, dict) else ""
            raise BrokerError(f"{msg} ({code})" if code else str(msg))
        return res.get("data")


class TTLCache:
    """Short-lived cache with single-flight: concurrent callers for a key share one fetch."""

    def __init__(self) -> None:
        self._values: dict[str, tuple[float, object]] = {}
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()

    def get(self, key: str, ttl: float, fetch):
        with self._guard:
            lock = self._locks.setdefault(key, threading.Lock())
        with lock:
            hit = self._values.get(key)
            if hit and time.monotonic() - hit[0] < ttl:
                return hit[1]
            value = fetch()
            self._values[key] = (time.monotonic(), value)
            return value

    def invalidate(self, *prefixes: str) -> None:
        with self._guard:
            for key in [k for k in self._values if not prefixes or k.startswith(prefixes)]:
                del self._values[key]


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
        # Several of these endpoints allow 1 request/s; pages and the order poller
        # share recent answers instead of each spending a request.
        self._cache = TTLCache()

    def _get(self, method: str, ttl: float):
        return self._cache.get(method, ttl, lambda: self.s.data(method) or [])

    def holdings(self) -> list[Holding]:
        rows = self._get("holding", 5.0)
        return [
            Holding(_symbol(d), d.get("exchange", ""), _i(d.get("quantity")) + _i(d.get("t1quantity")),
                    _f(d.get("averageprice")), _f(d.get("ltp")) or None, _f(d.get("close")) or None)
            for d in rows
        ]

    def positions(self) -> list[Position]:
        rows = self._get("position", 2.0)
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
        d = self._cache.get("rmsLimit", 3.0, lambda: self.s.data("rmsLimit") or {})
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
        rows = self._get("orderBook", 1.5)
        orders = [self._to_order(d) for d in rows]
        orders.sort(key=lambda o: o.updated_at, reverse=True)
        return orders

    def _find(self, order_id: str) -> Order:
        for o in self.orders():
            if o.order_id == order_id:
                return o
        raise BrokerError(f"Order {order_id} not found in today's order book")

    def trades(self) -> list[Trade]:
        rows = self._get("tradeBook", 2.0)
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
        self._cache.invalidate()
        order_id = str(data.get("orderid", ""))
        log.info("Angel One order placed: %s %s %s x%s -> %s", req.side, inst.symbol, req.order_type, req.quantity, order_id)
        try:
            return self._find_fresh(order_id)
        except BrokerError:
            # Accepted but not yet in the order book; report what we sent.
            return Order(order_id, inst.symbol, req.side, req.order_type, req.product, req.validity, req.quantity, 0,
                         req.price, req.trigger_price, None, "put order req received", "", datetime.now(IST).isoformat(), variety)

    def _find_fresh(self, order_id: str) -> Order:
        self._cache.invalidate("orderBook")
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
        self._cache.invalidate()
        return self._find_fresh(order_id)

    def cancel_order(self, order_id: str) -> None:
        o = self._find(order_id)
        self.s.data("cancelOrder", order_id, o.variety)
        self._cache.invalidate()

    def search(self, query: str, abort: threading.Event | None = None) -> list[Instrument]:
        rows = self.s.data("searchScrip", "NSE", query, abort=abort) or []
        found: dict[str, Instrument] = {}
        for d in rows:
            ts = d.get("tradingsymbol", "")
            if ts.endswith("-EQ"):  # cash-market equities only
                inst = registry.register("NSE", ts, d.get("symboltoken", ""))
                if inst:
                    found[inst.symbol] = inst
        return list(found.values())
