"""Angel One request pacing: limiter, rate-limit retries and shared cache."""

import threading
import time

import pytest

from app.broker.angel import AngelSession, TTLCache
from app.broker.base import BrokerError
from app.broker.ratelimit import Cancelled, RateLimiter


def test_same_endpoint_is_spaced_other_endpoints_are_not():
    limiter = RateLimiter({"a": 0.3, "b": 0.3})
    t0 = time.monotonic()
    limiter.acquire("a")
    limiter.acquire("b")  # different endpoint: no wait
    assert time.monotonic() - t0 < 0.1
    limiter.acquire("a")  # same endpoint: waits for its slot
    assert time.monotonic() - t0 >= 0.28


def test_waiting_caller_can_be_cancelled():
    limiter = RateLimiter({"a": 5.0})
    limiter.acquire("a")
    abort = threading.Event()
    threading.Timer(0.1, abort.set).start()
    t0 = time.monotonic()
    with pytest.raises(Cancelled):
        limiter.acquire("a", abort)
    assert time.monotonic() - t0 < 1.0


class FakeApi:
    """Rejects the first `failures` calls the way SmartAPI does when rate-limited."""

    def __init__(self, failures: int, as_exception: bool) -> None:
        self.failures = failures
        self.as_exception = as_exception
        self.calls: list[float] = []

    def holding(self):
        self.calls.append(time.monotonic())
        if len(self.calls) <= self.failures:
            if self.as_exception:
                raise Exception("Unknown Content-type (text/html) with response: (b'Access denied because of exceeding access rate')")
            return {"status": False, "message": "Access denied because of exceeding access rate", "errorcode": "", "data": None}
        return {"status": True, "message": "SUCCESS", "data": [{"tradingsymbol": "SBIN-EQ"}]}


def session_with(api: FakeApi) -> AngelSession:
    s = AngelSession({"api_key": "k", "client_code": "c", "pin": "1234", "totp_secret": "JBSWY3DPEHPK3PXP"})
    s.api = api  # skip login
    s.limiter = RateLimiter({"holding": 0.05})
    return s


@pytest.mark.parametrize("as_exception", [True, False])
def test_rate_limited_call_is_retried_after_backing_off(as_exception):
    api = FakeApi(failures=1, as_exception=as_exception)
    assert session_with(api).data("holding") == [{"tradingsymbol": "SBIN-EQ"}]
    assert len(api.calls) == 2
    assert api.calls[1] - api.calls[0] >= 0.95  # backed off ~1s before retrying


def test_persistent_rate_limit_gives_a_clear_error(monkeypatch):
    monkeypatch.setattr("app.broker.angel.AngelSession._back_off", lambda self, method, attempt: None)
    api = FakeApi(failures=99, as_exception=False)
    with pytest.raises(BrokerError, match="rate-limiting"):
        session_with(api).data("holding")


def test_cache_shares_one_fetch_between_concurrent_callers():
    cache = TTLCache()
    fetches = []

    def fetch():
        fetches.append(1)
        time.sleep(0.2)
        return "value"

    results = []
    threads = [threading.Thread(target=lambda: results.append(cache.get("k", 5, fetch))) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == ["value"] * 5 and len(fetches) == 1
    cache.invalidate()
    cache.get("k", 5, fetch)
    assert len(fetches) == 2
