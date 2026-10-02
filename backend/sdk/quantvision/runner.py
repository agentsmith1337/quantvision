"""Child-process entry point: loads a user script and drives its hooks.

    python -m quantvision.runner <script.py>

Protocol: one JSON object per line. The engine writes to our stdin; we answer on
the original stdout. The script's own print()/stderr output is captured and sent
as log messages, so it can't corrupt the protocol.
"""

import importlib.util
import io
import json
import sys
import traceback
from collections import deque
from pathlib import Path

from quantvision.api import Api
from quantvision.indicators import Indicators
from quantvision.models import Candle, Order

MAX_CONSECUTIVE_FAILURES = 5
SDK_DIR = str(Path(__file__).resolve().parent)


def user_traceback(exc: BaseException) -> str:
    """Traceback showing only the user's own frames, not the runner's or importlib's."""
    te = traceback.TracebackException.from_exception(exc)
    te.stack = traceback.StackSummary.from_list([f for f in te.stack if not f.filename.startswith((SDK_DIR, "<frozen"))])
    return "".join(te.format()).rstrip()


class _LogStream(io.TextIOBase):
    """Turns print() output into log messages."""

    def __init__(self, emit, level: str) -> None:
        self._emit, self._level, self._buf = emit, level, ""

    def write(self, s: str) -> int:
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            self._emit(self._level, line)
        return len(s)

    def flush(self) -> None:
        if self._buf:
            self._emit(self._level, self._buf)
            self._buf = ""


class Runner:
    def __init__(self, script_path: str, stdin, stdout) -> None:
        self.script_path = Path(script_path)
        self._in, self._out = stdin, stdout
        self._pending: deque[dict] = deque()
        self._next_id = 0
        self._current = ""
        self._failures = 0
        self.universe: list[str] = []
        self.module = None
        self.indicators: Indicators | None = None
        self.api: Api | None = None

    # --- protocol ------------------------------------------------------------------------

    def send(self, msg: dict) -> None:
        self._out.write(json.dumps(msg, default=str) + "\n")
        self._out.flush()

    def log(self, level: str, text: str) -> None:
        self.send({"type": "log", "level": level, "text": text})

    def _read(self) -> dict | None:
        line = self._in.readline()
        return json.loads(line) if line else None

    def call(self, method: str, params: dict):
        """Synchronous request to the engine; other messages that arrive meanwhile are queued."""
        self._next_id += 1
        rid = self._next_id
        self.send({"type": "request", "id": rid, "method": method, "params": params})
        while True:
            msg = self._read()
            if msg is None:
                raise SystemExit(0)  # engine went away
            if msg.get("type") == "reply" and msg.get("id") == rid:
                if msg.get("ok"):
                    return msg.get("result")
                raise RuntimeError(msg.get("error", "request failed"))
            if msg.get("type") == "stop":
                self._pending.appendleft(msg)
                raise SystemExit(0)
            self._pending.append(msg)

    # --- lifecycle --------------------------------------------------------------------------

    def load(self) -> bool:
        spec = importlib.util.spec_from_file_location("user_strategy", self.script_path)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception as e:
            self.send({"type": "fatal", "text": "Script failed to load:\n" + user_traceback(e)})
            return False
        if not callable(getattr(module, "on_candle", None)):
            self.send({"type": "fatal", "text": "The script must define on_candle(candle, indicators, api)"})
            return False
        self.module = module
        return True

    def init(self, msg: dict) -> None:
        self.universe = [s.upper() for s in msg["symbols"]]
        self._current = self.universe[0]
        self.indicators = Indicators(self.universe, lambda: self._current)
        for sym, bars in msg.get("history", {}).items():
            self.indicators.load(sym.upper(), bars)
        self.api = Api(self.call, self.log, self.universe, lambda: self._current, self.indicators.df, msg.get("mode", "paper"))

    def hook(self, name: str, *args) -> None:
        fn = getattr(self.module, name, None)
        if not callable(fn):
            return
        try:
            fn(*args)
            self._failures = 0
        except SystemExit:
            raise
        except Exception as e:
            self._failures += 1
            self.send({"type": "error", "where": name, "text": user_traceback(e)})
            if self._failures >= MAX_CONSECUTIVE_FAILURES:
                self.send({"type": "fatal", "text": f"Stopped after {MAX_CONSECUTIVE_FAILURES} consecutive errors"})
                raise SystemExit(1)

    def handle(self, msg: dict) -> bool:
        """Process one engine message; False means stop."""
        kind = msg.get("type")
        if kind == "candle":
            sym = msg["symbol"].upper()
            self.indicators.append(sym, msg["candle"])
            self._current = sym
            self.hook("on_candle", Candle.from_message(sym, msg["candle"]), self.indicators, self.api)
        elif kind == "order":
            order = Order.from_message(msg["order"])
            if order.symbol in self.universe:
                self._current = order.symbol
            self.hook("on_order", order, self.api)
        elif kind == "mode":
            self.api.mode = msg["mode"]
        elif kind == "stop":
            return False
        return True

    def run(self) -> int:
        if not self.load():
            return 1
        init = self._read()
        if not init or init.get("type") != "init":
            return 1
        self.init(init)
        self.send({"type": "ready"})
        try:
            self.hook("on_start", self.api)
            while True:
                msg = self._pending.popleft() if self._pending else self._read()
                if msg is None or not self.handle(msg):
                    break
        except SystemExit as e:
            if e.code:
                return int(e.code)
        finally:
            try:
                self.hook("on_stop", self.api)
            except SystemExit:
                pass
        return 0


def main() -> int:
    protocol_out = sys.stdout
    runner = Runner(sys.argv[1], sys.stdin, protocol_out)
    sys.stdout = _LogStream(runner.log, "info")
    sys.stderr = _LogStream(runner.log, "error")
    try:
        return runner.run()
    finally:
        sys.stdout.flush()
        sys.stderr.flush()


if __name__ == "__main__":
    sys.exit(main())
