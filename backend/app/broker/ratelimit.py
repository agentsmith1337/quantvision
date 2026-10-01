"""Per-endpoint request spacing for Angel One SmartAPI.

SmartAPI enforces limits per endpoint (several allow only one request per
second) and answers bursts with "Access denied because of exceeding access
rate". Callers wait here for their endpoint's next free slot instead.
"""

import threading
import time

# Minimum seconds between calls to each SmartConnect method.
SPACING: dict[str, float] = {
    "getCandleData": 1.0,
    "searchScrip": 1.0,
    "orderBook": 1.0,
    "tradeBook": 1.0,
    "holding": 1.0,
    "allholding": 1.0,
    "position": 1.0,
    "rmsLimit": 1.0,
    "generateSession": 1.0,
    "ltpData": 0.2,
    "placeOrder": 0.2,
    "modifyOrder": 0.2,
    "cancelOrder": 0.2,
}
DEFAULT_SPACING = 1.0


class Cancelled(Exception):
    """The caller stopped waiting (e.g. the browser abandoned the request)."""


class RateLimiter:
    def __init__(self, spacing: dict[str, float] | None = None, default: float = DEFAULT_SPACING) -> None:
        self._spacing = spacing or SPACING
        self._default = default
        self._next_free: dict[str, float] = {}
        self._lock = threading.Lock()

    def acquire(self, key: str, abort: threading.Event | None = None) -> None:
        """Block until `key` may be called, then claim the slot."""
        while True:
            with self._lock:
                now = time.monotonic()
                free_at = self._next_free.get(key, 0.0)
                if now >= free_at:
                    self._next_free[key] = now + self._spacing.get(key, self._default)
                    return
                wait = free_at - now
            if abort is not None and abort.is_set():
                raise Cancelled(key)
            time.sleep(min(wait, 0.05))

    def penalise(self, key: str, seconds: float) -> None:
        """Push back the next slot after the broker reported a rate-limit hit."""
        with self._lock:
            self._next_free[key] = max(self._next_free.get(key, 0.0), time.monotonic() + seconds)
