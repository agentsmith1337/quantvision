"""Strategy scripts as plain .py files in QV_HOME/scripts (editable in any editor too)."""

import ast
import re
from datetime import UTC, datetime
from pathlib import Path

NAME_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}\.py$")
MAX_BYTES = 256 * 1024
INTERVALS = {"1m", "5m", "15m", "1h", "1d"}

EXAMPLES = {
    "rsi_reversal.py": '''"""RSI reversal: buy oversold stocks, sell when they recover."""

SYMBOLS = ["RELIANCE", "TCS", "INFY"]
INTERVAL = "5m"

QUANTITY = 1


def on_start(api):
    api.log("RSI reversal started in", api.mode, "mode")


def on_candle(candle, indicators, api):
    rsi = indicators.rsi(period=14)
    if rsi is None:
        return  # not enough history yet

    held = api.position()
    if rsi < 30 and held == 0:
        api.log(candle.symbol, "oversold, RSI", round(rsi, 1))
        api.buy(quantity=QUANTITY)
    elif rsi > 70 and held > 0:
        api.log(candle.symbol, "recovered, RSI", round(rsi, 1))
        api.sell(quantity=held)


def on_order(order, api):
    api.log("order", order.side, order.symbol, order.status, order.average_price)
''',
    "sma_crossover.py": '''"""Trend following: hold while the 20-candle SMA is above the 50-candle SMA."""

SYMBOLS = ["SBIN"]
INTERVAL = "15m"


def on_candle(candle, indicators, api):
    fast = indicators.sma(period=20)
    slow = indicators.sma(period=50)
    if fast is None or slow is None:
        return

    held = api.position()
    if fast > slow and held == 0:
        api.buy(quantity=1)
    elif fast < slow and held > 0:
        api.sell(quantity=held)
''',
}


class ScriptError(ValueError):
    pass


class ScriptStore:
    def __init__(self, root: Path) -> None:
        self.root = root

    def _ensure(self) -> None:
        if not self.root.exists():
            self.root.mkdir(parents=True)
            for name, body in EXAMPLES.items():
                (self.root / name).write_text(body, encoding="utf-8")

    def path(self, name: str) -> Path:
        if not NAME_RE.fullmatch(name):
            raise ScriptError("Script names use letters, digits, '_' or '-' and end in .py")
        self._ensure()
        return self.root / name

    def list(self) -> list[dict]:
        self._ensure()
        out = []
        for p in sorted(self.root.glob("*.py")):
            if NAME_RE.fullmatch(p.name):
                st = p.stat()
                out.append({"name": p.name, "size": st.st_size, "modified": datetime.fromtimestamp(st.st_mtime, UTC).isoformat()})
        return out

    def read(self, name: str) -> str:
        p = self.path(name)
        if not p.exists():
            raise FileNotFoundError(name)
        return p.read_text(encoding="utf-8")

    def write(self, name: str, content: str) -> None:
        if len(content.encode("utf-8")) > MAX_BYTES:
            raise ScriptError("Scripts are limited to 256 KB")
        self.path(name).write_text(content, encoding="utf-8")

    def rename(self, name: str, new_name: str) -> None:
        src, dst = self.path(name), self.path(new_name)
        if not src.exists():
            raise FileNotFoundError(name)
        if dst.exists():
            raise ScriptError(f"{new_name} already exists")
        src.rename(dst)

    def delete(self, name: str) -> None:
        p = self.path(name)
        if not p.exists():
            raise FileNotFoundError(name)
        p.unlink()


def check_syntax(source: str, name: str) -> str | None:
    """A readable syntax error, or None. Parses only; never runs the script."""
    try:
        compile(source, name, "exec", dont_inherit=True)
    except SyntaxError as e:
        return f"{name}, line {e.lineno}: {e.msg}"
    return None


def script_defaults(source: str) -> dict:
    """SYMBOLS / INTERVAL literals at module level, read without executing the script."""
    out: dict = {"symbols": None, "interval": None, "has_on_candle": False}
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return out
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "on_candle":
            out["has_on_candle"] = True
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            target = node.targets[0].id
            try:
                value = ast.literal_eval(node.value)
            except ValueError:
                continue
            if target == "SYMBOLS" and isinstance(value, (list, tuple)) and all(isinstance(v, str) for v in value):
                out["symbols"] = [v.upper() for v in value]
            elif target == "INTERVAL" and value in INTERVALS:
                out["interval"] = value
    return out
