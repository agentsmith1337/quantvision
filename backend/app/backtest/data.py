"""Historical candles for backtests: Yahoo Finance (yfinance), cached locally as Parquet.

One file per stock and interval (`QV_HOME/data_cache/RELIANCE.NS_1d.parquet`) plus a small JSON
file recording which date ranges have been downloaded, so a later backtest over a longer range
only downloads what's missing. Today's candles are never marked as downloaded (the day isn't over).

Yahoo's limits: daily candles go back decades; 1h covers the last 730 days, 5m/15m the last 60 and
1m the last 30 (fetched 7 days at a time). Prices are split-adjusted but not dividend-adjusted.
"""

import json
import logging
import math
import re
import threading
import warnings
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

import pandas as pd

from app.market.instruments import Instrument

log = logging.getLogger(__name__)

IST = timezone(timedelta(hours=5, minutes=30))
INTERVALS = ("1d", "1h", "15m", "5m", "1m")
# How far back Yahoo serves each interval (days before today), and the most it returns per request.
MAX_DAYS_BACK = {"1d": None, "1h": 729, "15m": 59, "5m": 59, "1m": 29}
CHUNK_DAYS = {"1d": 3650, "1h": 729, "15m": 59, "5m": 59, "1m": 7}
# Calendar days that hold about WARMUP_BARS candles before the start date.
WARMUP_BARS = 300
WARMUP_DAYS = {"1d": 450, "1h": 80, "15m": 22, "5m": 9, "1m": 4}
COLUMNS = ["open", "high", "low", "close", "volume"]

# Yahoo symbols for the indices QuantVision knows (by Angel One name, upper-case).
INDEX_TICKERS = {
    "NIFTY 50": "^NSEI", "NIFTY": "^NSEI", "NIFTY BANK": "^NSEBANK", "BANKNIFTY": "^NSEBANK", "SENSEX": "^BSESN",
    "NIFTY IT": "^CNXIT", "NIFTY FIN SERVICE": "NIFTY_FIN_SERVICE.NS", "FINNIFTY": "NIFTY_FIN_SERVICE.NS",
    "NIFTY NEXT 50": "^NSMIDCP", "NIFTY 100": "^CNX100", "NIFTY 200": "^CNX200", "NIFTY 500": "^CRSLDX",
    "NIFTY MIDCAP 50": "^NSEMDCP50", "NIFTY MIDCAP 100": "NIFTY_MIDCAP_100.NS", "NIFTY SMLCAP 100": "^CNXSC",
    "NIFTY AUTO": "^CNXAUTO", "NIFTY PHARMA": "^CNXPHARMA", "NIFTY FMCG": "^CNXFMCG", "NIFTY METAL": "^CNXMETAL",
    "NIFTY REALTY": "^CNXREALTY", "NIFTY ENERGY": "^CNXENERGY", "NIFTY PSU BANK": "^CNXPSUBANK", "NIFTY MEDIA": "^CNXMEDIA",
    "NIFTY INFRA": "^CNXINFRA", "NIFTY PVT BANK": "NIFTY_PVT_BANK.NS", "INDIA VIX": "^INDIAVIX", "BANKEX": "BSE-BANK.BO",
}
BENCHMARK = "^NSEI"


class DataError(ValueError):
    """A problem with historical data worth showing the user."""


def yahoo_ticker(inst: Instrument) -> str:
    if inst.is_index:
        for key in (inst.name.upper(), inst.trading_symbol.upper(), inst.symbol.split(":")[-1].upper()):
            if key in INDEX_TICKERS:
                return INDEX_TICKERS[key]
        raise DataError(f"{inst.symbol} ({inst.name}) isn't available from Yahoo Finance")
    base = re.sub(r"-[A-Z0-9]{1,2}$", "", inst.trading_symbol.upper())  # RELIANCE-EQ -> RELIANCE
    return f"{base}.BO" if inst.exchange == "BSE" else f"{base}.NS"


def today_ist() -> date:
    return datetime.now(IST).date()


def earliest(interval: str, today: date | None = None) -> date | None:
    days = MAX_DAYS_BACK[interval]
    return None if days is None else (today or today_ist()) - timedelta(days=days)


def _download(ticker: str, interval: str, start: date, end: date) -> pd.DataFrame:
    """Candles in [start, end) from Yahoo (monkeypatched in tests)."""
    import yfinance as yf

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        df = yf.Ticker(ticker).history(start=start.isoformat(), end=end.isoformat(), interval=interval, auto_adjust=False, actions=False, raise_errors=False)
    return df


def normalise(raw: pd.DataFrame, interval: str) -> pd.DataFrame:
    """Lower-case OHLCV columns, IST index; daily candles start at 09:15 like live candles."""
    if raw is None or raw.empty:
        return pd.DataFrame(columns=COLUMNS, index=pd.DatetimeIndex([], tz=IST))
    df = raw.rename(columns=str.lower)[[c for c in COLUMNS if c in raw.rename(columns=str.lower).columns]].copy()
    for c in COLUMNS:
        if c not in df:
            df[c] = 0.0
    idx = pd.DatetimeIndex(df.index)
    idx = idx.tz_localize(IST) if idx.tz is None else idx.tz_convert(IST)
    if interval == "1d":
        idx = idx.normalize() + pd.Timedelta(hours=9, minutes=15)
    df.index = idx
    df = df[COLUMNS].astype(float)
    df["volume"] = df["volume"].fillna(0.0)
    df = df.dropna(subset=["open", "high", "low", "close"])
    df = df[(df["close"] > 0)]
    return df[~df.index.duplicated(keep="last")].sort_index()


def _merge_ranges(ranges: list[list[str]]) -> list[list[date]]:
    parsed = sorted([date.fromisoformat(a), date.fromisoformat(b)] for a, b in ranges)
    out: list[list[date]] = []
    for a, b in parsed:
        if out and a <= out[-1][1] + timedelta(days=1):
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return out


def missing_ranges(covered: list[list[date]], start: date, end: date) -> list[tuple[date, date]]:
    gaps, cursor = [], start
    for a, b in covered:
        if b < cursor:
            continue
        if a > end:
            break
        if a > cursor:
            gaps.append((cursor, min(end, a - timedelta(days=1))))
        cursor = max(cursor, b + timedelta(days=1))
        if cursor > end:
            break
    if cursor <= end:
        gaps.append((cursor, end))
    return gaps


class HistoryCache:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self._yf_ready = False

    def _lock(self, key: str) -> threading.Lock:
        with self._guard:
            return self._locks.setdefault(key, threading.Lock())

    def _files(self, ticker: str, interval: str) -> tuple[Path, Path]:
        stem = re.sub(r"[^A-Za-z0-9_.-]", "_", ticker) + f"_{interval}"
        return self.root / f"{stem}.parquet", self.root / f"{stem}.json"

    def _setup_yfinance(self) -> None:
        if self._yf_ready:
            return
        try:
            import yfinance as yf

            (self.root / "yfinance").mkdir(parents=True, exist_ok=True)
            yf.set_tz_cache_location(str(self.root / "yfinance"))  # keep yfinance's files with ours
        except Exception:  # noqa: BLE001 - only a cache location
            pass
        self._yf_ready = True

    def candles(self, ticker: str, interval: str, start: date, end: date, on_download=None) -> pd.DataFrame:
        """Candles from `start` to `end` (inclusive), downloading whatever isn't cached."""
        today = today_ist()
        end = min(end, today)
        if start > end:
            return normalise(pd.DataFrame(), interval)
        data_path, meta_path = self._files(ticker, interval)
        with self._lock(f"{ticker}_{interval}"):
            self.root.mkdir(parents=True, exist_ok=True)
            meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {"ranges": []}
            covered = _merge_ranges(meta.get("ranges", []))
            stored = pd.read_parquet(data_path) if data_path.exists() and covered else normalise(pd.DataFrame(), interval)
            gaps = missing_ranges(covered, start, end)
            if gaps:
                self._setup_yfinance()
                if on_download:
                    on_download()
                parts = [stored]
                for a, b in gaps:
                    cursor = a
                    while cursor <= b:
                        chunk_end = min(b, cursor + timedelta(days=CHUNK_DAYS[interval] - 1))
                        log.info("yfinance: %s %s %s..%s", ticker, interval, cursor, chunk_end)
                        try:
                            raw = _download(ticker, interval, cursor, chunk_end + timedelta(days=1))
                        except Exception as e:  # noqa: BLE001 - network/Yahoo problems
                            raise DataError(f"Couldn't download {ticker} from Yahoo Finance: {e}") from e
                        parts.append(normalise(raw, interval))
                        cursor = chunk_end + timedelta(days=1)
                    done_until = min(b, today - timedelta(days=1))
                    if done_until >= a:
                        covered.append([a, done_until])
                merged = pd.concat([p for p in parts if len(p)]) if any(len(p) for p in parts) else stored
                merged = merged[~merged.index.duplicated(keep="last")].sort_index()
                merged.to_parquet(data_path)
                covered = _merge_ranges([[a.isoformat(), b.isoformat()] for a, b in covered])
                meta_path.write_text(json.dumps({"ticker": ticker, "interval": interval,
                                                 "ranges": [[a.isoformat(), b.isoformat()] for a, b in covered]}), encoding="utf-8")
                stored = merged
        lo = pd.Timestamp(datetime.combine(start, time.min), tz=IST)
        hi = pd.Timestamp(datetime.combine(end + timedelta(days=1), time.min), tz=IST)
        return stored[(stored.index >= lo) & (stored.index < hi)]


@dataclass
class Prepared:
    frames: dict[str, pd.DataFrame]  # symbol -> warm-up + range candles
    benchmark: pd.DataFrame | None
    warnings: list[str] = field(default_factory=list)


def validate_range(interval: str, start: date, end: date, today: date | None = None) -> None:
    today = today or today_ist()
    if interval not in INTERVALS:
        raise DataError(f"Interval must be one of {', '.join(INTERVALS)}")
    if start > end:
        raise DataError("The start date must be before the end date")
    if start > today:
        raise DataError("The start date is in the future")
    first = earliest(interval, today)
    if first is not None and start < first:
        raise DataError(f"Yahoo Finance only has {interval} candles for the last {MAX_DAYS_BACK[interval] + 1} days "
                        f"(from {first.isoformat()}); choose a later start date or a longer interval")


def prepare(cache: HistoryCache, instruments: list[Instrument], interval: str, start: date, end: date, progress=None) -> Prepared:
    """Download/cache everything a backtest needs. `progress(text)` reports what's happening."""
    validate_range(interval, start, end)
    first = earliest(interval)
    warm_start = start - timedelta(days=WARMUP_DAYS[interval])
    if first is not None:
        warm_start = max(warm_start, first)
    frames, notes = {}, []
    lo = pd.Timestamp(datetime.combine(start, time.min), tz=IST)
    for n, inst in enumerate(instruments, 1):
        ticker = yahoo_ticker(inst)
        if progress:
            progress(f"Loading {inst.symbol} ({n}/{len(instruments)})")
        df = cache.candles(ticker, interval, warm_start, end,
                           on_download=(lambda s=inst.symbol, i=n: progress and progress(f"Downloading {s} from Yahoo Finance ({i}/{len(instruments)})")))
        in_range = df[df.index >= lo]
        if in_range.empty:
            raise DataError(f"Yahoo Finance has no {interval} candles for {inst.symbol} ({ticker}) between {start} and {end}")
        warm = len(df) - len(in_range)
        if warm < WARMUP_BARS and warm < 200:
            notes.append(f"{inst.symbol}: only {warm} candles of history before {start}, so long-period indicators return None at first")
        if in_range.index[0].date() > start + timedelta(days=7):
            notes.append(f"{inst.symbol}: data starts on {in_range.index[0].date()} (listed later, or missing on Yahoo)")
        frames[inst.symbol] = df
    bench = None
    try:
        if progress:
            progress("Loading the NIFTY 50 benchmark")
        b = cache.candles(BENCHMARK, interval, start, end)
        bench = b if len(b) else None
    except DataError as e:
        notes.append(f"Benchmark unavailable: {e}")
    if bench is None:
        notes.append("NIFTY 50 benchmark data unavailable for this range")
    return Prepared(frames, bench, notes)


def bars_estimate(interval: str, start: date, end: date) -> int:
    days = (end - start).days + 1
    per_day = {"1d": 1, "1h": 7, "15m": 25, "5m": 75, "1m": 375}[interval]
    return math.ceil(days * 5 / 7 * per_day)
