"""Instrument registry.

A QuantVision symbol is the key used in URLs, watchlists and the local
WebSocket. NSE equities use the bare name ("RELIANCE" for RELIANCE-EQ); anything
else is "EXCHANGE:TRADINGSYMBOL" (e.g. "BSE:RELIANCE"). Indices have fixed keys.
Instruments found through search or holdings are stored so their Angel One
tokens survive restarts.
"""

import threading
from dataclasses import asdict, dataclass, replace

# SmartWebSocketV2 exchange types
EXCHANGE_TYPES = {"NSE": 1, "BSE": 3}


@dataclass(frozen=True)
class Instrument:
    symbol: str
    name: str
    exchange: str  # "NSE" / "BSE"
    token: str  # Angel One symbol token
    trading_symbol: str  # Angel One trading symbol, e.g. "RELIANCE-EQ"
    is_index: bool = False

    @property
    def exchange_type(self) -> int:
        return EXCHANGE_TYPES[self.exchange]

    def to_dict(self) -> dict:
        return {**asdict(self), "exchange_type": self.exchange_type}


def symbol_key(exchange: str, trading_symbol: str) -> str:
    ts = trading_symbol.upper()
    if exchange == "NSE" and ts.endswith("-EQ"):
        return ts[:-3]
    return f"{exchange}:{ts}"


def parse_key(symbol: str) -> tuple[str, str]:
    """Inverse of symbol_key: ("NSE", "RELIANCE-EQ") for "RELIANCE"."""
    exchange, sep, rest = symbol.upper().partition(":")
    return (exchange, rest) if sep else ("NSE", f"{exchange}-EQ")


BUILTIN: list[Instrument] = [
    Instrument("NIFTY", "Nifty 50", "NSE", "99926000", "Nifty 50", is_index=True),
    Instrument("BANKNIFTY", "Nifty Bank", "NSE", "99926009", "Nifty Bank", is_index=True),
    Instrument("SENSEX", "BSE Sensex", "BSE", "99919000", "SENSEX", is_index=True),
    Instrument("RELIANCE", "Reliance Industries", "NSE", "2885", "RELIANCE-EQ"),
    Instrument("TCS", "Tata Consultancy Services", "NSE", "11536", "TCS-EQ"),
    Instrument("INFY", "Infosys", "NSE", "1594", "INFY-EQ"),
    Instrument("HDFCBANK", "HDFC Bank", "NSE", "1333", "HDFCBANK-EQ"),
    Instrument("ICICIBANK", "ICICI Bank", "NSE", "4963", "ICICIBANK-EQ"),
    Instrument("SBIN", "State Bank of India", "NSE", "3045", "SBIN-EQ"),
    Instrument("ITC", "ITC", "NSE", "1660", "ITC-EQ"),
]
INDEX_SYMBOLS = [i.symbol for i in BUILTIN if i.is_index]
DEFAULT_WATCHLIST = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN"]


class InstrumentRegistry:
    def __init__(self) -> None:
        self._by_symbol = {i.symbol: i for i in BUILTIN}
        self._by_token = {(i.exchange_type, i.token): i for i in BUILTIN}
        self._lock = threading.Lock()

    def load(self) -> None:
        from app.db import SessionLocal
        from app.models import InstrumentRow

        with SessionLocal() as db:
            for row in db.query(InstrumentRow).all():
                if row.exchange in EXCHANGE_TYPES:
                    self._add(Instrument(row.symbol.upper(), row.name, row.exchange, row.token, row.trading_symbol, bool(row.is_index)))

    def _add(self, inst: Instrument) -> Instrument:
        with self._lock:
            existing = self._by_symbol.get(inst.symbol)
            if existing:
                return existing
            self._by_symbol[inst.symbol] = inst
            self._by_token[(inst.exchange_type, inst.token)] = inst
            return inst

    def register(self, exchange: str, trading_symbol: str, token: str, name: str | None = None, is_index: bool = False) -> Instrument | None:
        """Add (and persist) an instrument seen in the scrip master or broker data."""
        if exchange not in EXCHANGE_TYPES:
            return None
        # Built-ins (e.g. NIFTY) keep their short keys even when found under another name.
        if existing := self._by_token.get((EXCHANGE_TYPES[exchange], str(token))):
            return existing
        key = symbol_key(exchange, trading_symbol)
        if key in self._by_symbol:
            return self._by_symbol[key]
        inst = self._add(Instrument(key, name or trading_symbol.removesuffix("-EQ"), exchange, str(token), trading_symbol, is_index))

        from app.db import SessionLocal
        from app.models import InstrumentRow

        with SessionLocal() as db:
            if db.get(InstrumentRow, key) is None:
                db.add(InstrumentRow(symbol=key, exchange=exchange, trading_symbol=trading_symbol, token=str(token), name=inst.name, is_index=is_index))
                db.commit()
        return inst

    def get(self, symbol: str) -> Instrument | None:
        key = symbol.upper()
        inst = self._by_symbol.get(key)
        if inst is None:
            # Not seen before (e.g. a URL or watchlist entry): resolve its token from the scrip master.
            from app.market.scripmaster import scripmaster

            row = scripmaster.find(*parse_key(key))
            if row is not None:
                inst = self.from_scrip(row)
        return inst

    def preview(self, row) -> Instrument:
        """Instrument for a scrip-master row without registering it (search results)."""
        existing = self._by_token.get((EXCHANGE_TYPES[row.exchange], row.token))
        if existing is None:
            existing = self._by_symbol.get(symbol_key(row.exchange, row.trading_symbol))
        if existing is not None:
            return self._with_company_name(existing, row)
        key = symbol_key(row.exchange, row.trading_symbol)
        return Instrument(key, row.display_name, row.exchange, row.token, row.trading_symbol, row.is_index)

    def from_scrip(self, row) -> Instrument | None:
        """Instrument for a scrip-master row (registered on first use)."""
        inst = self.register(row.exchange, row.trading_symbol, row.token, row.display_name, row.is_index)
        return self._with_company_name(inst, row) if inst else None

    def apply_company_names(self, rows) -> None:
        """Give instruments registered under a bare ticker their company names."""
        by_key = {(r.exchange, r.trading_symbol.upper()): r for r in rows if r.company}
        with self._lock:
            stale = [i for i in self._by_symbol.values() if i not in BUILTIN]
        renames = [(i, row) for i in stale if (row := by_key.get((i.exchange, i.trading_symbol.upper()))) and i.name != row.display_name]
        for inst, row in renames:
            self._with_company_name(inst, row)

    def _with_company_name(self, inst: Instrument, row) -> Instrument:
        """Upgrade an instrument registered under its bare ticker to its company name."""
        if not row.company or inst.name == row.display_name or inst in BUILTIN:
            return inst
        renamed = replace(inst, name=row.display_name)
        with self._lock:
            self._by_symbol[renamed.symbol] = renamed
            self._by_token[(renamed.exchange_type, renamed.token)] = renamed

        from app.db import SessionLocal
        from app.models import InstrumentRow

        with SessionLocal() as db:
            if stored := db.get(InstrumentRow, renamed.symbol):
                stored.name = renamed.name
                db.commit()
        return renamed

    def by_token(self, exchange_type: int, token: str) -> Instrument | None:
        return self._by_token.get((exchange_type, token))

    def builtin(self) -> list[Instrument]:
        return list(BUILTIN)

    def local_search(self, query: str, limit: int = 20) -> list[Instrument]:
        q = query.upper()
        with self._lock:
            hits = [i for i in self._by_symbol.values() if q in i.symbol or q in i.name.upper()]
        hits.sort(key=lambda i: (not i.symbol.startswith(q), i.symbol))
        return hits[:limit]


registry = InstrumentRegistry()
