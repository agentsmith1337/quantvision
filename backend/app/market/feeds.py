"""Upstream market data feeds: Angel One SmartAPI, or a simulated feed for
development and for running the app without broker credentials."""

import logging
import math
import random
import threading
import time
import zlib
from abc import ABC, abstractmethod
from datetime import datetime, timedelta, timezone

from app.broker.base import BrokerError
from app.market.hub import FeedStatus, MarketHub, Tick
from app.market.instruments import Instrument, registry

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))


class FeedUnavailable(Exception):
    pass


# Interval -> (Angel One interval name, seconds per bar, max days per Angel request)
INTERVALS: dict[str, tuple[str, int, int]] = {
    "1m": ("ONE_MINUTE", 60, 30),
    "5m": ("FIVE_MINUTE", 300, 100),
    "15m": ("FIFTEEN_MINUTE", 900, 200),
    "1h": ("ONE_HOUR", 3600, 400),
    "1d": ("ONE_DAY", 86400, 2000),
}


class MarketFeed(ABC):
    mode: str

    def __init__(self, hub: MarketHub) -> None:
        self.hub = hub
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._wanted: dict[str, Instrument] = {i.symbol: i for i in registry.builtin()}
        self._wanted_lock = threading.Lock()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"{self.mode}-feed", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def ensure_subscribed(self, instruments: list[Instrument]) -> None:
        with self._wanted_lock:
            new = [i for i in instruments if i.symbol not in self._wanted]
            for i in new:
                self._wanted[i.symbol] = i
        if new:
            self._subscribe(new)

    def _subscribe(self, instruments: list[Instrument]) -> None:
        """Start streaming newly wanted instruments (no-op if not connected yet)."""

    def wanted(self) -> list[Instrument]:
        with self._wanted_lock:
            return list(self._wanted.values())

    def _status(self, state: str, message: str = "") -> None:
        self.hub.set_status_threadsafe(FeedStatus(self.mode, state, message))

    @abstractmethod
    def _run(self) -> None: ...

    @abstractmethod
    def candles(self, inst: Instrument, interval: str, days: int) -> list[dict]:
        """Historical OHLCV bars, oldest first, `time` in epoch seconds. Blocking."""


class AngelOneFeed(MarketFeed):
    mode = "angelone"

    def __init__(self, hub: MarketHub, session) -> None:
        super().__init__(hub)
        self.session = session  # app.broker.angel.AngelSession
        self._ws = None
        self._ws_open = False

    def stop(self) -> None:
        super().stop()
        if self._ws is not None:
            try:
                self._ws.close_connection()
            except Exception:
                pass

    def _run(self) -> None:
        from SmartApi.smartWebSocketV2 import SmartWebSocketV2

        backoff = 5
        while not self._stop.is_set():
            self._status("connecting")
            try:
                self.session.login()
                ws = SmartWebSocketV2(
                    self.session.access_token,
                    self.session.api_key,
                    self.session.client_code,
                    self.session.feed_token,
                    max_retry_attempt=0,  # reconnects (with a fresh login) are handled by this loop
                )
                ws.on_open = lambda _app: self._on_open(ws)
                ws.on_data = lambda _app, data: self._on_data(data)
                ws.on_error = lambda *args: log.warning("Angel One WebSocket error: %s", args)
                ws.on_close = lambda _app: None
                # The SDK's own close handler has the wrong signature for websocket-client
                # (it logs a TypeError on every close); replace it.
                ws._on_close = lambda _app, *_: None
                self._ws = ws
                connected_at = time.monotonic()
                ws.connect()  # blocks until the socket closes
                self._ws_open = False
                if time.monotonic() - connected_at > 60:
                    backoff = 5
                if self._stop.is_set():
                    break
                self._status("disconnected", f"Connection lost; reconnecting in {backoff}s")
            except Exception as e:
                self._ws_open = False
                log.warning("Angel One feed failed: %s", e)
                self._status("error", f"{e}. Retrying in {backoff}s")
            self._stop.wait(backoff)
            backoff = min(backoff * 2, 120)

    def _on_open(self, ws) -> None:
        self._ws_open = True
        self._send_subscribe(ws, self.wanted())
        self._status("connected")

    def _subscribe(self, instruments: list[Instrument]) -> None:
        if self._ws is not None and self._ws_open:
            self._send_subscribe(self._ws, instruments)

    @staticmethod
    def _send_subscribe(ws, instruments: list[Instrument]) -> None:
        by_exchange: dict[int, list[str]] = {}
        for i in instruments:
            by_exchange.setdefault(i.exchange_type, []).append(i.token)
        # Quote mode carries day open/high/low and previous close (indices included).
        for ex, tokens in by_exchange.items():
            for chunk in range(0, len(tokens), 50):
                ws.subscribe("qvquote", ws.QUOTE, [{"exchangeType": ex, "tokens": tokens[chunk:chunk + 50]}])

    def _on_data(self, data: dict) -> None:
        inst = registry.by_token(data.get("exchange_type"), str(data.get("token")))
        if inst is None or "last_traded_price" not in data:
            return

        def rupees(key: str) -> float | None:  # Angel One streams prices in paise
            return data[key] / 100 if data.get(key) else None

        tick = Tick(
            symbol=inst.symbol,
            ltp=data["last_traded_price"] / 100,
            ts=int(data.get("exchange_timestamp") or time.time() * 1000),
            prev_close=rupees("closed_price"),
            open=rupees("open_price_of_the_day"),
            high=rupees("high_price_of_the_day"),
            low=rupees("low_price_of_the_day"),
            volume=data.get("volume_trade_for_the_day") or None,
        )
        self.hub.publish_threadsafe(tick)

    def candles(self, inst: Instrument, interval: str, days: int) -> list[dict]:
        name, _, max_days = INTERVALS[interval]
        to = datetime.now(IST)
        frm = to - timedelta(days=min(days, max_days))
        params = {
            "exchange": inst.exchange,
            "symboltoken": inst.token,
            "interval": name,
            "fromdate": frm.strftime("%Y-%m-%d %H:%M"),
            "todate": to.strftime("%Y-%m-%d %H:%M"),
        }
        try:
            rows = self.session.data("getCandleData", params) or []
        except BrokerError as e:
            raise FeedUnavailable(f"Angel One candle request failed: {e}") from e
        return [
            {"time": int(datetime.fromisoformat(ts).timestamp()), "open": o, "high": h, "low": l, "close": c, "volume": v}
            for ts, o, h, l, c, v in rows
        ]


# Rough reference levels so simulated prices look plausible.
_SIM_BASE = {
    "NIFTY": 25000.0, "BANKNIFTY": 55000.0, "SENSEX": 82000.0, "RELIANCE": 1400.0,
    "TCS": 3100.0, "INFY": 1500.0, "HDFCBANK": 1950.0, "ICICIBANK": 1400.0, "SBIN": 820.0, "ITC": 410.0,
}


def _sim_base(symbol: str) -> float:
    if symbol in _SIM_BASE:
        return _SIM_BASE[symbol]
    return float(50 + zlib.crc32(symbol.encode()) % 3000)


class SimulatedFeed(MarketFeed):
    """Random-walk prices for every wanted instrument, one tick per second each."""

    mode = "simulated"
    VOLATILITY = 0.0006  # per-second standard deviation, as a fraction of price

    def __init__(self, hub: MarketHub) -> None:
        super().__init__(hub)
        self._lock = threading.Lock()
        self._rng = random.Random()
        self._state: dict[str, dict] = {}

    def _st(self, symbol: str) -> dict:
        st = self._state.get(symbol)
        if st is None:
            p = _sim_base(symbol)
            st = self._state[symbol] = {"prev_close": p, "open": p, "high": p, "low": p, "ltp": p, "volume": 0}
        return st

    def _run(self) -> None:
        self._status("connected", "Simulated prices. Add Angel One credentials in Settings for live data.")
        while not self._stop.wait(1.0):
            now_ms = int(time.time() * 1000)
            for inst in self.wanted():
                with self._lock:
                    st = self._st(inst.symbol)
                    st["ltp"] = round(st["ltp"] * (1 + self._rng.gauss(0, self.VOLATILITY)), 2)
                    st["high"] = max(st["high"], st["ltp"])
                    st["low"] = min(st["low"], st["ltp"])
                    if not inst.is_index:
                        st["volume"] += self._rng.randint(50, 5000)
                    tick = Tick(inst.symbol, st["ltp"], now_ms, st["prev_close"], st["open"],
                                st["high"], st["low"], st["volume"] or None)
                self.hub.publish_threadsafe(tick)

    def candles(self, inst: Instrument, interval: str, days: int) -> list[dict]:
        _, step, _ = INTERVALS[interval]
        count = min(days * 86400 // step, 1500)
        with self._lock:
            last = self._st(inst.symbol)["ltp"]
        # Walk backwards from the current price so history joins the live ticks.
        # A per-symbol seed keeps the shape stable across reloads.
        rng = random.Random(zlib.crc32(f"{inst.symbol}:{interval}".encode()))
        sigma = self.VOLATILITY * math.sqrt(step)
        end = int(time.time()) // step * step
        bars, close = [], last
        for n in range(count):
            open_ = close / (1 + rng.gauss(0, sigma))
            high = max(open_, close) * (1 + abs(rng.gauss(0, sigma / 3)))
            low = min(open_, close) * (1 - abs(rng.gauss(0, sigma / 3)))
            bars.append({
                "time": end - n * step,
                "open": round(open_, 2), "high": round(high, 2), "low": round(low, 2),
                "close": round(close, 2), "volume": 0 if inst.is_index else rng.randint(10_000, 500_000),
            })
            close = open_
        bars.reverse()
        return bars
