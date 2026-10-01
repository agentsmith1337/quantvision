"""Instruments known to the app.

Phase 1 ships a small built-in list of Angel One symbol tokens. Searching the
full Angel One scrip master comes later with the portfolio search bar.
"""

from dataclasses import asdict, dataclass

# SmartWebSocketV2 exchange types
NSE_CM = 1
BSE_CM = 3


@dataclass(frozen=True)
class Instrument:
    symbol: str  # QuantVision symbol used in URLs and the local WebSocket
    name: str
    exchange: str  # Angel One REST exchange ("NSE" / "BSE")
    exchange_type: int  # Angel One WebSocket exchange type
    token: str  # Angel One symbol token
    trading_symbol: str  # Angel One trading symbol (for getLTPData)
    is_index: bool = False

    def to_dict(self) -> dict:
        return asdict(self)


INSTRUMENTS: list[Instrument] = [
    Instrument("NIFTY", "Nifty 50", "NSE", NSE_CM, "99926000", "Nifty 50", is_index=True),
    Instrument("BANKNIFTY", "Nifty Bank", "NSE", NSE_CM, "99926009", "Nifty Bank", is_index=True),
    Instrument("SENSEX", "BSE Sensex", "BSE", BSE_CM, "99919000", "SENSEX", is_index=True),
    Instrument("RELIANCE", "Reliance Industries", "NSE", NSE_CM, "2885", "RELIANCE-EQ"),
    Instrument("TCS", "Tata Consultancy Services", "NSE", NSE_CM, "11536", "TCS-EQ"),
    Instrument("INFY", "Infosys", "NSE", NSE_CM, "1594", "INFY-EQ"),
    Instrument("HDFCBANK", "HDFC Bank", "NSE", NSE_CM, "1333", "HDFCBANK-EQ"),
    Instrument("ICICIBANK", "ICICI Bank", "NSE", NSE_CM, "4963", "ICICIBANK-EQ"),
    Instrument("SBIN", "State Bank of India", "NSE", NSE_CM, "3045", "SBIN-EQ"),
    Instrument("ITC", "ITC", "NSE", NSE_CM, "1660", "ITC-EQ"),
]

BY_SYMBOL = {i.symbol: i for i in INSTRUMENTS}
BY_TOKEN = {(i.exchange_type, i.token): i for i in INSTRUMENTS}

DEFAULT_WATCHLIST = ["RELIANCE", "TCS", "INFY", "HDFCBANK", "SBIN"]
