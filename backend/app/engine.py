"""The trading engine: owns the market feed, the brokers and the order poller.

It is locked until the user signs in (the broker credentials can only be
decrypted with their password) and locks again on sign-out.
"""

import logging
import threading
import time
import urllib.request
from collections import deque
from datetime import datetime, timedelta, timezone

from app import prefs
from app.broker.angel import AngelBroker, AngelSession
from app.broker.base import Broker, BrokerError, Order, OrderChanges, OrderRequest
from app.broker.paper import PaperBroker
from app.config import settings
from app.market.feeds import AngelOneFeed, MarketFeed, SimulatedFeed
from app.market.hub import FeedStatus, MarketHub
from app.market.instruments import Instrument, registry
from app.market.scripmaster import scripmaster

log = logging.getLogger(__name__)
IST = timezone(timedelta(hours=5, minutes=30))
POLL_SECONDS = 3
SCRIP_MASTER_CACHE = settings.home_dir / "scripmaster.json"


def market_hours(now: datetime | None = None) -> bool:
    """NSE/BSE cash session (incl. pre-open and closing session), weekdays only.
    Exchange holidays aren't modelled; polling on a holiday is merely wasted calls."""
    now = now or datetime.now(IST)
    if now.weekday() >= 5:
        return False
    minutes = now.hour * 60 + now.minute
    return 9 * 60 <= minutes <= 16 * 60


class Engine:
    def __init__(self, hub: MarketHub) -> None:
        self.hub = hub
        self.user_id: int | None = None
        self.vault_key: bytes | None = None
        self.angel: AngelSession | None = None
        self.feed: MarketFeed | None = None
        self.paper: PaperBroker | None = None
        self.live: AngelBroker | None = None
        self._lock = threading.RLock()
        self._poll_stop = threading.Event()
        self._last_activity = 0.0
        self._order_times: deque[float] = deque()
        self._known_orders: dict[str, tuple] = {}
        self._search_cache: dict[str, list[Instrument]] = {}
        self._ip_cache: tuple[float, dict] | None = None
        hub.on_demand = self._on_demand

    # --- lifecycle --------------------------------------------------------------

    @property
    def running(self) -> bool:
        return self.feed is not None

    def start(self, user_id: int, vault_key: bytes, creds: dict | None) -> None:
        with self._lock:
            self.stop()
            self.user_id, self.vault_key = user_id, vault_key
            if creds and settings.market_data != "simulated":
                self.angel = AngelSession(creds)
                self.feed = AngelOneFeed(self.hub, self.angel)
                self.live = AngelBroker(self.angel)
                self.live.on_order_update(self._broadcast_order)
            else:
                self.feed = SimulatedFeed(self.hub)
            self.paper = PaperBroker(self.hub, settings.home_dir / "paper.json")
            self.paper.on_order_update(self._broadcast_order)
            self.feed.ensure_subscribed(self._resolve(self.hub.demanded_symbols()))
            self.feed.start()
            self._poll_stop = threading.Event()
            threading.Thread(target=self._poll_loop, args=(self._poll_stop,), name="order-poller", daemon=True).start()
            log.info("engine started (%s feed, %s trading)", self.feed.mode, self.trading_mode)

    def stop(self) -> None:
        with self._lock:
            self._poll_stop.set()
            if self.feed:
                self.feed.stop()
            if self.paper:
                self.hub.remove_tick_listener(self.paper.on_tick)
            self.feed = self.paper = self.live = self.angel = None
            self.user_id = self.vault_key = None
            self._known_orders.clear()
            self._search_cache.clear()
            self.hub.clear_ticks()
            self.hub.set_status_threadsafe(FeedStatus("none", "locked", "Sign in to connect"))

    # --- brokers ----------------------------------------------------------------

    @property
    def trading_mode(self) -> str:
        return "live" if prefs.get("trading_mode") == "live" and self.live is not None else "paper"

    @property
    def broker(self) -> Broker:
        if not self.running or self.paper is None:
            raise BrokerError("Engine is locked; sign in first")
        return self.live if self.trading_mode == "live" else self.paper

    def set_trading_mode(self, mode: str) -> str:
        if mode == "live" and self.live is None:
            raise BrokerError("Live trading needs Angel One credentials (Settings → API configuration)")
        prefs.put("trading_mode", mode)
        self._known_orders.clear()
        return self.trading_mode

    def place_order(self, req: OrderRequest) -> Order:
        inst = registry.get(req.symbol)
        if inst is None:
            raise BrokerError(f"Unknown symbol {req.symbol}")
        risk = prefs.get("risk")
        tick = self.hub.last_tick(inst.symbol)
        ref = req.price or req.trigger_price or (tick.ltp if tick else None)
        if ref is not None and ref * req.quantity > float(risk["max_order_value"]):
            raise BrokerError(
                f"Order value ₹{ref * req.quantity:,.0f} exceeds your limit of ₹{float(risk['max_order_value']):,.0f} "
                "(Settings → Preferences)"
            )
        now = time.monotonic()
        with self._lock:
            while self._order_times and now - self._order_times[0] > 60:
                self._order_times.popleft()
            if len(self._order_times) >= int(risk["max_orders_per_minute"]):
                raise BrokerError("Order rate limit reached; wait a minute (Settings → Preferences)")
            self._order_times.append(now)
        self._last_activity = now
        broker = self.broker
        self._ensure_streaming([inst])
        order = broker.place_order(req, inst)
        if broker is self.live:
            self._broadcast_order(order)
        return order

    def modify_order(self, order_id: str, changes: OrderChanges) -> Order:
        self._last_activity = time.monotonic()
        return self.broker.modify_order(order_id, changes)

    def cancel_order(self, order_id: str) -> None:
        self._last_activity = time.monotonic()
        self.broker.cancel_order(order_id)

    def cancel_all(self) -> dict:
        """Kill switch for manual trading: cancel every open order."""
        self._last_activity = time.monotonic()
        cancelled, failed = [], []
        for o in self.broker.orders():
            if o.is_open:
                try:
                    self.broker.cancel_order(o.order_id)
                    cancelled.append(o.order_id)
                except BrokerError as e:
                    failed.append({"order_id": o.order_id, "error": str(e)})
        return {"cancelled": cancelled, "failed": failed}

    def _broadcast_order(self, order: Order) -> None:
        self.hub.broadcast_threadsafe({"type": "order", "broker": self.trading_mode, "order": order.to_dict()})

    def _poll_loop(self, stop: threading.Event) -> None:
        """Angel One doesn't stream order status; poll the order book and push changes."""
        while not stop.wait(POLL_SECONDS):
            live = self.live
            if live is None or self.trading_mode != "live":
                continue
            recent = time.monotonic() - self._last_activity < 120
            has_open = any(state[0] for state in self._known_orders.values())
            if not (market_hours() or recent or has_open):
                continue
            try:
                orders = live.orders()
            except BrokerError as e:
                log.warning("order poll failed: %s", e)
                continue
            first = not self._known_orders
            for o in orders:
                state = (o.is_open, o.status, o.filled_quantity)
                if self._known_orders.get(o.order_id) != state:
                    self._known_orders[o.order_id] = state
                    if not first:
                        self._broadcast_order(o)

    # --- market data ------------------------------------------------------------

    def _resolve(self, symbols) -> list[Instrument]:
        return [i for s in symbols if (i := registry.get(s)) is not None]

    def _on_demand(self, symbols: set[str]) -> None:
        self._ensure_streaming(self._resolve(symbols))

    def _ensure_streaming(self, instruments: list[Instrument]) -> None:
        if self.feed and instruments:
            self.feed.ensure_subscribed(instruments)

    def search(self, query: str, abort: threading.Event | None = None) -> list[Instrument]:
        """Search Angel One's daily scrip master locally: no SmartAPI calls per keystroke."""
        q = query.strip().upper()
        if len(q) < 2:
            return []
        scripmaster.ensure_fresh(SCRIP_MASTER_CACHE)  # cheap unless a new day's file is due
        if scripmaster.loaded:
            return [registry.preview(r) for r in scripmaster.search(q)]
        # Scrip master not downloaded yet (first run offline): fall back to Angel One's search.
        local = registry.local_search(q)
        if self.live is None:
            return local
        if q not in self._search_cache:
            try:
                self._search_cache[q] = self.live.search(q, abort)
            except BrokerError as e:
                log.warning("search failed: %s", e)
                return local
        merged = {i.symbol: i for i in local + self._search_cache[q]}
        ranked = sorted(merged.values(), key=lambda i: (not i.is_index, not i.symbol.startswith(q), len(i.symbol), i.symbol))
        return ranked[:25]

    # --- static IP check ----------------------------------------------------------

    def ip_check(self, refresh: bool = False) -> dict:
        """Compare this machine's public IP with the IPs whitelisted for the Angel One app."""
        if self._ip_cache and not refresh and time.monotonic() - self._ip_cache[0] < 300:
            return self._ip_cache[1]
        ips = prefs.get("static_ips")
        allowed = [ip for ip in (ips.get("primary"), ips.get("secondary")) if ip]
        try:
            with urllib.request.urlopen("https://api.ipify.org", timeout=4) as r:
                public = r.read().decode().strip()
        except OSError as e:
            result = {"public_ip": None, "allowed": allowed, "match": None, "error": f"Couldn't detect public IP: {e}"}
        else:
            result = {"public_ip": public, "allowed": allowed, "match": public in allowed if allowed else None, "error": None}
        self._ip_cache = (time.monotonic(), result)
        return result


from app.market.hub import hub as _hub  # noqa: E402

engine = Engine(_hub)
