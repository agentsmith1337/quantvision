"""Angel One equity trading charges, used by backtests.

Defaults follow Angel One's published tariff (angelone.in/exchange-transaction-charges, checked
October 2026). Every value can be changed per backtest in the Studio, since tariffs change.
"""

from dataclasses import asdict, dataclass, fields

# Percentages are of turnover (price x quantity) unless noted.
DEFAULTS = {
    "brokerage_pct": 0.1,  # lower of this % or brokerage_max per executed order...
    "brokerage_max": 20.0,  # ...rupees
    "brokerage_min": 5.0,  # ...but at least this many rupees
    "stt_delivery_pct": 0.1,  # buy and sell
    "stt_intraday_sell_pct": 0.025,
    "exchange_nse_pct": 0.0030699,
    "exchange_bse_pct": 0.00375,
    "sebi_pct": 0.0001,  # Rs 10 per crore
    "ipft_pct": 0.0001,  # NSE investor protection fund, Rs 10 per crore
    "stamp_delivery_buy_pct": 0.015,
    "stamp_intraday_buy_pct": 0.003,
    "gst_pct": 18.0,  # on brokerage + exchange + SEBI + IPFT (+ DP)
    "dp_per_sell": 20.0,  # rupees per delivery sell order (Angel One charges per scrip per day)
}


@dataclass
class Charges:
    brokerage: float = 0.0
    stt: float = 0.0
    exchange: float = 0.0
    sebi: float = 0.0
    stamp: float = 0.0
    dp: float = 0.0
    gst: float = 0.0

    @property
    def total(self) -> float:
        return sum(getattr(self, f.name) for f in fields(self))

    def to_dict(self) -> dict:
        return {**{k: round(v, 4) for k, v in asdict(self).items()}, "total": round(self.total, 4)}


def config(overrides: dict | None = None) -> dict:
    """DEFAULTS with valid overrides applied (unknown keys and negative values are ignored)."""
    out = dict(DEFAULTS)
    for key, value in (overrides or {}).items():
        if key in out and isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            out[key] = float(value)
    return out


def compute(side: str, product: str, price: float, quantity: int, exchange: str = "NSE", cfg: dict | None = None) -> Charges:
    """Charges for one executed order (side 'BUY'/'SELL', product 'DELIVERY'/'INTRADAY')."""
    c = cfg or DEFAULTS
    turnover = abs(price * quantity)
    pct = lambda key: turnover * c[key] / 100  # noqa: E731
    delivery, buy = product == "DELIVERY", side == "BUY"
    ch = Charges()
    ch.brokerage = max(min(pct("brokerage_pct"), c["brokerage_max"]), c["brokerage_min"]) if turnover else 0.0
    ch.brokerage = min(ch.brokerage, turnover)  # never more than the trade itself
    ch.stt = pct("stt_delivery_pct") if delivery else (0.0 if buy else pct("stt_intraday_sell_pct"))
    ch.exchange = pct("exchange_bse_pct" if exchange == "BSE" else "exchange_nse_pct") + (pct("ipft_pct") if exchange != "BSE" else 0.0)
    ch.sebi = pct("sebi_pct")
    ch.stamp = (pct("stamp_delivery_buy_pct") if delivery else pct("stamp_intraday_buy_pct")) if buy else 0.0
    ch.dp = c["dp_per_sell"] if delivery and not buy else 0.0
    ch.gst = (ch.brokerage + ch.exchange + ch.sebi + ch.dp) * c["gst_pct"] / 100
    return ch
