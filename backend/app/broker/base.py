"""Broker-neutral types. Both the Angel One and paper brokers speak these."""

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.market.instruments import Instrument

Side = Literal["BUY", "SELL"]
OrderType = Literal["MARKET", "LIMIT", "SL", "SL-M"]
Product = Literal["DELIVERY", "INTRADAY"]
Validity = Literal["DAY", "IOC"]

# Statuses after which an order can still fill or be cancelled.
OPEN_STATUSES = {
    "open", "pending", "trigger pending", "open pending", "validation pending", "modify pending",
    "modified", "put order req received", "after market order req received", "modify validation pending",
}


class BrokerError(Exception):
    """A broker rejected or failed a request; the message is safe to show the user."""


class OrderRequest(BaseModel):
    symbol: str
    side: Side
    quantity: int = Field(gt=0, le=100_000)
    order_type: OrderType = "MARKET"
    product: Product = "DELIVERY"
    validity: Validity = "DAY"
    price: float | None = Field(default=None, gt=0)
    trigger_price: float | None = Field(default=None, gt=0)
    amo: bool = False  # after-market order
    # Set by the engine for script orders ("qvrun<id>"); Angel One stores it as the order tag.
    tag: str | None = Field(default=None, max_length=20, pattern=r"^[A-Za-z0-9]+$")

    @model_validator(mode="after")
    def _check_prices(self) -> "OrderRequest":
        if self.order_type in ("LIMIT", "SL") and self.price is None:
            raise ValueError(f"{self.order_type} orders need a price")
        if self.order_type in ("SL", "SL-M") and self.trigger_price is None:
            raise ValueError(f"{self.order_type} orders need a trigger price")
        if self.order_type in ("MARKET", "SL-M"):
            self.price = None
        if self.order_type in ("MARKET", "LIMIT"):
            self.trigger_price = None
        if self.order_type == "SL" and self.price is not None and self.trigger_price is not None:
            if self.side == "BUY" and self.trigger_price > self.price:
                raise ValueError("For a stop-loss buy, the trigger price must not be above the limit price")
            if self.side == "SELL" and self.trigger_price < self.price:
                raise ValueError("For a stop-loss sell, the trigger price must not be below the limit price")
        return self


class OrderChanges(BaseModel):
    quantity: int | None = Field(default=None, gt=0, le=100_000)
    price: float | None = Field(default=None, gt=0)
    trigger_price: float | None = Field(default=None, gt=0)


@dataclass
class Order:
    order_id: str
    symbol: str
    side: str
    order_type: str
    product: str
    validity: str
    quantity: int
    filled_quantity: int
    price: float | None
    trigger_price: float | None
    average_price: float | None
    status: str  # lower-case broker status, e.g. "open", "complete", "rejected"
    message: str
    updated_at: str  # ISO 8601
    variety: str = "NORMAL"
    source: str = "manual"  # "manual" or the tag of the script run that placed it

    @property
    def is_open(self) -> bool:
        return self.status in OPEN_STATUSES

    def to_dict(self) -> dict:
        return {**asdict(self), "is_open": self.is_open}


@dataclass
class Trade:
    trade_id: str
    order_id: str
    symbol: str
    side: str
    product: str
    quantity: int
    price: float
    time: str  # ISO 8601

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Holding:
    symbol: str
    exchange: str
    quantity: int
    average_price: float
    ltp: float | None
    close: float | None

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Position:
    symbol: str
    product: str
    net_quantity: int
    buy_quantity: int
    sell_quantity: int
    buy_average: float
    sell_average: float
    ltp: float | None
    realised_pnl: float

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Funds:
    available_cash: float
    used_margin: float
    net: float

    def to_dict(self) -> dict:
        return asdict(self)


OrderListener = Callable[[Order], None]


class Broker(ABC):
    name: str  # "angelone" | "paper"

    def __init__(self) -> None:
        self._listeners: list[OrderListener] = []

    def on_order_update(self, fn: OrderListener) -> None:
        self._listeners.append(fn)

    def _emit(self, order: Order) -> None:
        for fn in self._listeners:
            fn(replace(order))  # a snapshot: the broker keeps mutating its own copy

    @abstractmethod
    def holdings(self) -> list[Holding]: ...

    @abstractmethod
    def positions(self) -> list[Position]: ...

    @abstractmethod
    def funds(self) -> Funds: ...

    @abstractmethod
    def orders(self) -> list[Order]: ...

    @abstractmethod
    def trades(self) -> list[Trade]: ...

    @abstractmethod
    def place_order(self, req: OrderRequest, inst: Instrument) -> Order: ...

    @abstractmethod
    def modify_order(self, order_id: str, changes: OrderChanges) -> Order: ...

    @abstractmethod
    def cancel_order(self, order_id: str) -> None: ...
