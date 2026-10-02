"""Builds closed candles from the live tick stream for running scripts.

Intraday buckets are aligned to the 09:15 IST market open (so 1h candles are
09:15, 10:15, … like Angel One's history); daily buckets to IST midnight. A
candle closes when a tick lands in the next bucket or, for quiet stocks, shortly
after its interval ends.
"""

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

from app.market.hub import Tick

log = logging.getLogger(__name__)

IST_OFFSET = 19800
SESSION_OPEN = 9 * 3600 + 15 * 60  # 09:15 IST
STEPS = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "1d": 86400}
CLOSE_GRACE = 1.5  # seconds after the interval ends before a quiet candle is closed

CandleCallback = Callable[[str, str, dict], None]  # (symbol, interval, candle)


def bucket_start(ts: float, step: int) -> int:
    """Epoch seconds (UTC) of the start of the bucket containing ts."""
    local = ts + IST_OFFSET
    day = int(local // 86400) * 86400
    if step >= 86400:
        return day - IST_OFFSET
    anchor = day + SESSION_OPEN
    return int(anchor + ((local - anchor) // step) * step) - IST_OFFSET


@dataclass
class _Building:
    start: int
    open: float
    high: float
    low: float
    close: float
    volume: int
    last_day_volume: int | None

    def as_dict(self) -> dict:
        return {"time": self.start, "open": self.open, "high": self.high, "low": self.low, "close": self.close, "volume": self.volume}


class CandleBuilder:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._lock = threading.Lock()
        self._subs: dict[tuple[str, str], list[CandleCallback]] = {}
        self._building: dict[tuple[str, str], _Building] = {}
        self._day_volume: dict[str, int] = {}
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def subscribe(self, symbol: str, interval: str, fn: CandleCallback) -> Callable[[], None]:
        key = (symbol, interval)
        with self._lock:
            self._subs.setdefault(key, []).append(fn)

        def unsubscribe() -> None:
            with self._lock:
                fns = self._subs.get(key, [])
                if fn in fns:
                    fns.remove(fn)
                if not fns:
                    self._subs.pop(key, None)
                    self._building.pop(key, None)

        return unsubscribe

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._timer, name="candle-builder", daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    # --- input ---------------------------------------------------------------------------

    def on_tick(self, tick: Tick) -> None:
        t = tick.ts / 1000
        closed: list[tuple[tuple[str, str], dict]] = []
        with self._lock:
            keys = [k for k in self._subs if k[0] == tick.symbol]
            prev_day_vol = self._day_volume.get(tick.symbol)
            if tick.volume is not None:
                self._day_volume[tick.symbol] = tick.volume
            # Ticks carry cumulative day volume; attribute the increase to the current candle.
            vol_delta = max(0, tick.volume - prev_day_vol) if tick.volume is not None and prev_day_vol is not None else 0
            for key in keys:
                start = bucket_start(t, STEPS[key[1]])
                b = self._building.get(key)
                if b is not None and start > b.start:
                    closed.append((key, b.as_dict()))
                    b = None
                if b is None:
                    self._building[key] = _Building(start, tick.ltp, tick.ltp, tick.ltp, tick.ltp, vol_delta, tick.volume)
                elif start == b.start:
                    b.high, b.low, b.close = max(b.high, tick.ltp), min(b.low, tick.ltp), tick.ltp
                    b.volume += vol_delta
                # Ticks older than the building candle (out of order) are ignored.
        self._emit(closed)

    def _timer(self) -> None:
        while not self._stop.wait(0.5):
            self.close_due()

    def close_due(self) -> None:
        """Close candles whose interval has ended (quiet stocks get no next tick)."""
        now = self._clock()
        closed = []
        with self._lock:
            for key, b in list(self._building.items()):
                if now >= b.start + STEPS[key[1]] + CLOSE_GRACE:
                    closed.append((key, b.as_dict()))
                    del self._building[key]
        self._emit(closed)

    def _emit(self, closed: list[tuple[tuple[str, str], dict]]) -> None:
        for (symbol, interval), candle in closed:
            with self._lock:
                fns = list(self._subs.get((symbol, interval), []))
            for fn in fns:
                try:
                    fn(symbol, interval, candle)
                except Exception:
                    log.exception("candle subscriber failed")
