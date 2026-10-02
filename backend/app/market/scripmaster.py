"""Angel One's daily instrument file (the "scrip master"), used for symbol search.

Angel One publishes every tradable instrument with its symbol token once a day.
Searching a local copy costs no SmartAPI calls (searchScrip is limited to about
1 request/second) and works without credentials. The ~34 MB file is filtered to
NSE/BSE cash equities and indices and cached in QV_HOME, refreshed once a day.

The scrip master only carries tickers, so company names come from NSE's list of
listed equities (EQUITY_L.csv). BSE listings take the name of the NSE company
with the same symbol; BSE-only companies stay ticker-only.
"""

import csv
import io
import json
import logging
import re
import threading
import urllib.request
from dataclasses import astuple, dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

log = logging.getLogger(__name__)

URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
NSE_COMPANIES_URL = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"
IST = timezone(timedelta(hours=5, minutes=30))
# Angel One regenerates the file early each morning; before this, yesterday's copy is current.
REFRESH_AFTER_IST_HOUR = 8
CACHE_VERSION = 2  # bump when the cached row format changes


@dataclass(frozen=True)
class ScripRow:
    exchange: str  # "NSE" / "BSE"
    trading_symbol: str  # Angel One trading symbol, e.g. "RELIANCE-EQ"
    token: str
    name: str  # ticker-style name from the scrip master, e.g. "RELIANCE"
    is_index: bool
    company: str = ""  # e.g. "Reliance Industries"; empty when unknown

    @property
    def display_name(self) -> str:
        return self.company or self.name


def _keep(r: dict) -> ScripRow | None:
    exch, itype, sym = r.get("exch_seg"), r.get("instrumenttype") or "", r.get("symbol") or ""
    if exch not in ("NSE", "BSE"):
        return None
    if itype == "AMXIDX":
        return ScripRow(exch, sym, str(r["token"]), (r.get("name") or sym).upper(), True, sym)
    if itype:
        return None
    if exch == "NSE" and not sym.endswith("-EQ"):
        return None  # other NSE series (BE, BL, IQ…) are block/odd-lot segments
    return ScripRow(exch, sym, str(r["token"]), (r.get("name") or sym).upper(), False)


def filter_rows(raw: list[dict], companies: dict[str, str] | None = None) -> list[ScripRow]:
    """Cash equities and indices, with company names attached where known."""
    companies = companies or {}
    out = []
    for r in raw:
        row = _keep(r)
        if row is None:
            continue
        if not row.is_index:
            company = companies.get(row.trading_symbol.removesuffix("-EQ").upper(), "")
            if company:
                row = ScripRow(*astuple(row)[:5], company)
        out.append(row)
    return out


_SUFFIX = re.compile(r"\s+(limited|ltd\.?)$", re.IGNORECASE)


def parse_nse_companies(text: str) -> dict[str, str]:
    """SYMBOL -> company name from NSE's EQUITY_L.csv ("Limited" dropped for display)."""
    names = {}
    for rec in csv.DictReader(io.StringIO(text)):
        rec = {k.strip(): (v or "").strip() for k, v in rec.items() if k}
        if rec.get("SYMBOL") and rec.get("NAME OF COMPANY"):
            names[rec["SYMBOL"].upper()] = _SUFFIX.sub("", rec["NAME OF COMPANY"])
    return names


def _fetch(url: str, timeout: int) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (QuantVision)"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.read()


class ScripMaster:
    def __init__(self) -> None:
        self._rows: list[ScripRow] = []
        self._date: str | None = None
        self._lock = threading.Lock()
        self._loading = threading.Event()
        self._listeners: list = []

    def on_update(self, fn) -> None:
        """Call fn(rows) whenever a new copy is loaded."""
        self._listeners.append(fn)

    @property
    def loaded(self) -> bool:
        return bool(self._rows)

    @property
    def date(self) -> str | None:
        return self._date

    def set_rows(self, rows: list[ScripRow], date: str | None) -> None:
        with self._lock:
            self._rows, self._date = rows, date
        for fn in self._listeners:
            try:
                fn(rows)
            except Exception:
                log.exception("scrip master listener failed")

    # --- loading -----------------------------------------------------------------

    def ensure_fresh(self, cache_path: Path, background: bool = True) -> None:
        """Load the cached copy, and download today's file if the cache is stale."""
        if not self.loaded:
            self._load_cache(cache_path)
        if not self._stale():
            return
        if self._loading.is_set():
            return
        self._loading.set()
        if background:
            threading.Thread(target=self._refresh, args=(cache_path,), name="scripmaster", daemon=True).start()
        else:
            self._refresh(cache_path)

    def _stale(self) -> bool:
        now = datetime.now(IST)
        expected = now.date() if now.hour >= REFRESH_AFTER_IST_HOUR else now.date() - timedelta(days=1)
        return self._date is None or self._date < expected.isoformat()

    def _load_cache(self, path: Path) -> None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            rows = [ScripRow(*r) for r in data["rows"]]
        except (OSError, ValueError, KeyError, TypeError):
            return
        # An older cache format still serves searches, but counts as stale so it's replaced today.
        self.set_rows(rows, data["date"] if data.get("version") == CACHE_VERSION else None)
        log.info("scrip master: %d instruments from cache (%s)", len(rows), data.get("date"))

    def _refresh(self, path: Path) -> None:
        try:
            raw = json.loads(_fetch(URL, timeout=90))
            companies = self._companies()
            rows = filter_rows(raw, companies)
            if len(rows) < 1000:
                raise ValueError(f"only {len(rows)} usable instruments")
            today = datetime.now(IST).date().isoformat()
            self.set_rows(rows, today)
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps({"version": CACHE_VERSION, "date": today, "rows": [astuple(r) for r in rows]}), encoding="utf-8")
            tmp.replace(path)
            log.info("scrip master: downloaded %d instruments (%d with company names)", len(rows), sum(1 for r in rows if r.company and not r.is_index))
        except Exception as e:  # network, JSON, disk: keep whatever copy we have
            log.warning("scrip master download failed (%s); %s", e, "using cached copy" if self.loaded else "search falls back to Angel One")
        finally:
            self._loading.clear()

    def _companies(self) -> dict[str, str]:
        """NSE company names; on failure, reuse the names already loaded."""
        try:
            return parse_nse_companies(_fetch(NSE_COMPANIES_URL, timeout=30).decode("utf-8-sig"))
        except Exception as e:
            log.warning("NSE company list unavailable (%s); keeping previous names", e)
            with self._lock:
                return {r.trading_symbol.removesuffix("-EQ").upper(): r.company for r in self._rows if r.company and not r.is_index}

    # --- queries -------------------------------------------------------------------

    def search(self, query: str, limit: int = 25) -> list[ScripRow]:
        q = " ".join(query.strip().upper().split())
        if not q:
            return []
        with self._lock:
            rows = self._rows
        scored: list[tuple[tuple, ScripRow]] = []
        for r in rows:
            base = r.trading_symbol.removesuffix("-EQ").upper()
            company = r.company.upper()
            if base == q or r.name == q or company == q:
                rank = 0
            elif base.startswith(q):
                rank = 1
            elif company.startswith(q) or r.name.startswith(q):
                rank = 2
            elif any(word.startswith(q) for word in company.split()):
                rank = 3  # "bank" finds "State Bank of India"
            elif q in base or q in company or q in r.name:
                rank = 4
            else:
                continue
            # Prefer indices, then NSE over BSE, then shorter symbols.
            scored.append(((rank, not r.is_index, r.exchange != "NSE", len(base), base), r))
        scored.sort(key=lambda x: x[0])
        return [r for _, r in scored[:limit]]

    def find(self, exchange: str, trading_symbol: str) -> ScripRow | None:
        with self._lock:
            for r in self._rows:
                if r.exchange == exchange and r.trading_symbol.upper() == trading_symbol.upper():
                    return r
        return None


scripmaster = ScripMaster()
