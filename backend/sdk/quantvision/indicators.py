"""`indicators`: technical indicators on each stock's candle history (pandas-ta-classic)."""

from collections import namedtuple
from collections.abc import Callable

import pandas as pd
import pandas_ta_classic as ta

MACD = namedtuple("MACD", "macd signal histogram")
BBands = namedtuple("BBands", "upper middle lower")
Stoch = namedtuple("Stoch", "k d")
Supertrend = namedtuple("Supertrend", "value direction")
ADX = namedtuple("ADX", "adx plus_di minus_di")

MAX_ROWS = 1000  # history kept per stock


def _last(value) -> float | None:
    """Latest value of a Series/scalar as a float, None while there isn't enough history."""
    if value is None:
        return None
    if isinstance(value, (pd.Series, pd.DataFrame)):
        if len(value) == 0:
            return None
        value = value.iloc[-1]
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if f != f else f  # NaN -> None


def _col(frame: pd.DataFrame | None, prefix: str) -> float | None:
    if frame is None:
        return None
    for name in frame.columns:
        if str(name).startswith(prefix):
            return _last(frame[name])
    return None


class Indicators:
    def __init__(self, universe: list[str], current: Callable[[], str]) -> None:
        self._frames: dict[str, pd.DataFrame] = {}
        self._universe = universe
        self._current = current

    # --- data management (used by the runner) --------------------------------------

    def load(self, symbol: str, bars: list[dict]) -> None:
        df = pd.DataFrame(bars, columns=["time", "open", "high", "low", "close", "volume"])
        df.index = pd.to_datetime(df.pop("time"), unit="s", utc=True).dt.tz_convert("Asia/Kolkata")
        self._frames[symbol] = df.astype({"open": float, "high": float, "low": float, "close": float, "volume": float}).tail(MAX_ROWS)

    def append(self, symbol: str, bar: dict) -> None:
        ts = pd.to_datetime(bar["time"], unit="s", utc=True).tz_convert("Asia/Kolkata")
        row = pd.DataFrame([[float(bar[k]) for k in ("open", "high", "low", "close", "volume")]], columns=["open", "high", "low", "close", "volume"], index=[ts])
        df = self._frames.get(symbol)
        df = row if df is None or df.empty else pd.concat([df[df.index < ts], row])
        self._frames[symbol] = df.tail(MAX_ROWS)

    # --- user-facing ------------------------------------------------------------------

    def df(self, symbol: str | None = None) -> pd.DataFrame:
        """OHLCV history of a stock (DatetimeIndex in IST), for any pandas-ta-classic indicator."""
        sym = self._resolve(symbol)
        return self._frames.get(sym, pd.DataFrame(columns=["open", "high", "low", "close", "volume"])).copy()

    def sma(self, period: int = 20, symbol: str | None = None) -> float | None:
        return _last(ta.sma(self._close(symbol), length=period))

    def ema(self, period: int = 20, symbol: str | None = None) -> float | None:
        return _last(ta.ema(self._close(symbol), length=period))

    def wma(self, period: int = 20, symbol: str | None = None) -> float | None:
        return _last(ta.wma(self._close(symbol), length=period))

    def rsi(self, period: int = 14, symbol: str | None = None) -> float | None:
        return _last(ta.rsi(self._close(symbol), length=period))

    def atr(self, period: int = 14, symbol: str | None = None) -> float | None:
        d = self._frame(symbol)
        return _last(ta.atr(d["high"], d["low"], d["close"], length=period)) if len(d) else None

    def vwap(self, symbol: str | None = None) -> float | None:
        """Volume-weighted average price, reset each trading day."""
        d = self._frame(symbol)
        if not len(d) or not d["volume"].any():
            return None
        return _last(ta.vwap(d["high"], d["low"], d["close"], d["volume"], anchor="D"))

    def macd(self, fast: int = 12, slow: int = 26, signal: int = 9, symbol: str | None = None) -> MACD:
        frame = ta.macd(self._close(symbol), fast=fast, slow=slow, signal=signal)
        return MACD(_col(frame, "MACD_"), _col(frame, "MACDs_"), _col(frame, "MACDh_"))

    def bbands(self, period: int = 20, std: float = 2.0, symbol: str | None = None) -> BBands:
        frame = ta.bbands(self._close(symbol), length=period, std=std)
        return BBands(_col(frame, "BBU_"), _col(frame, "BBM_"), _col(frame, "BBL_"))

    def stoch(self, k: int = 14, d: int = 3, smooth_k: int = 3, symbol: str | None = None) -> Stoch:
        f = self._frame(symbol)
        frame = ta.stoch(f["high"], f["low"], f["close"], k=k, d=d, smooth_k=smooth_k) if len(f) else None
        return Stoch(_col(frame, "STOCHk_"), _col(frame, "STOCHd_"))

    def supertrend(self, period: int = 7, multiplier: float = 3.0, symbol: str | None = None) -> Supertrend:
        f = self._frame(symbol)
        frame = ta.supertrend(f["high"], f["low"], f["close"], length=period, multiplier=multiplier) if len(f) else None
        direction = _col(frame, "SUPERTd_")
        return Supertrend(_col(frame, "SUPERT_"), int(direction) if direction is not None else None)

    def adx(self, period: int = 14, symbol: str | None = None) -> ADX:
        f = self._frame(symbol)
        frame = ta.adx(f["high"], f["low"], f["close"], length=period) if len(f) else None
        return ADX(_col(frame, "ADX_"), _col(frame, "DMP_"), _col(frame, "DMN_"))

    # --- helpers ------------------------------------------------------------------------

    def _resolve(self, symbol: str | None) -> str:
        sym = (symbol or self._current()).upper()
        if sym not in self._universe:
            raise ValueError(f"{sym} isn't in this run's symbols {self._universe}; add it in the Run dialog or SYMBOLS")
        return sym

    def _frame(self, symbol: str | None) -> pd.DataFrame:
        return self._frames.get(self._resolve(symbol), pd.DataFrame(columns=["open", "high", "low", "close", "volume"]))

    def _close(self, symbol: str | None) -> pd.Series:
        return self._frame(symbol)["close"]
