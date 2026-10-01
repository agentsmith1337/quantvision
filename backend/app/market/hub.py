"""Fans market data out from the upstream feed to local UI WebSocket clients."""

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from fastapi import WebSocket

log = logging.getLogger(__name__)


@dataclass
class Tick:
    symbol: str
    ltp: float
    ts: int  # exchange timestamp, epoch milliseconds
    prev_close: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    volume: int | None = None

    def to_message(self) -> dict[str, Any]:
        msg: dict[str, Any] = {"type": "tick", **asdict(self)}
        if self.prev_close:
            msg["change"] = round(self.ltp - self.prev_close, 2)
            msg["change_pct"] = round((self.ltp - self.prev_close) / self.prev_close * 100, 2)
        return msg


@dataclass
class FeedStatus:
    mode: str  # "angelone" | "simulated"
    state: str  # "connecting" | "connected" | "disconnected" | "error"
    message: str = ""

    def to_message(self) -> dict[str, Any]:
        return {"type": "status", **asdict(self)}


@dataclass(eq=False)
class _Client:
    ws: WebSocket
    symbols: set[str] = field(default_factory=set)
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=500))


class MarketHub:
    def __init__(self) -> None:
        self._clients: set[_Client] = set()
        self._last_ticks: dict[str, Tick] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self.status = FeedStatus(mode="simulated", state="disconnected")

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # --- called from feed threads -------------------------------------------------

    def publish_threadsafe(self, tick: Tick) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self.publish, tick)

    def set_status_threadsafe(self, status: FeedStatus) -> None:
        if self._loop and not self._loop.is_closed():
            self._loop.call_soon_threadsafe(self.set_status, status)

    # --- event loop side ----------------------------------------------------------

    def last_tick(self, symbol: str) -> Tick | None:
        return self._last_ticks.get(symbol)

    def publish(self, tick: Tick) -> None:
        prev = self._last_ticks.get(tick.symbol)
        if prev and tick.prev_close is None:
            tick.prev_close = prev.prev_close
        self._last_ticks[tick.symbol] = tick
        msg = tick.to_message()
        for client in self._clients:
            if tick.symbol in client.symbols:
                self._enqueue(client, msg)

    def set_status(self, status: FeedStatus) -> None:
        self.status = status
        log.info("market feed %s: %s %s", status.mode, status.state, status.message)
        msg = status.to_message()
        for client in self._clients:
            self._enqueue(client, msg)

    @staticmethod
    def _enqueue(client: _Client, msg: dict[str, Any]) -> None:
        try:
            client.queue.put_nowait(msg)
        except asyncio.QueueFull:
            # A stalled browser tab must not hold up the feed; drop its oldest tick.
            client.queue.get_nowait()
            client.queue.put_nowait(msg)

    async def serve(self, ws: WebSocket) -> None:
        """Run one UI connection until it disconnects.

        Client messages: {"op": "subscribe" | "unsubscribe", "symbols": [...]}.
        """
        await ws.accept()
        client = _Client(ws)
        self._clients.add(client)
        sender = asyncio.create_task(self._send_loop(client))
        try:
            await ws.send_json(self.status.to_message())
            while True:
                req = await ws.receive_json()
                symbols = {str(s).upper() for s in req.get("symbols", [])}
                if req.get("op") == "subscribe":
                    client.symbols |= symbols
                    for s in symbols:
                        if tick := self._last_ticks.get(s):
                            self._enqueue(client, tick.to_message())
                elif req.get("op") == "unsubscribe":
                    client.symbols -= symbols
        except Exception:
            pass  # disconnect or malformed message: drop the client
        finally:
            self._clients.discard(client)
            sender.cancel()

    @staticmethod
    async def _send_loop(client: _Client) -> None:
        while True:
            await client.ws.send_json(await client.queue.get())


hub = MarketHub()
