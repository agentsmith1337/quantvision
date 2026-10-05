"""Supervises running strategy scripts: one sandboxed Python process per run.

The engine feeds each run closed candles and order updates; the run's script
calls back for orders, positions and prices. Every order goes through the
engine's normal risk checks plus a per-run rate limit, so a script can't
bypass them.
"""

import json
import logging
import queue
import secrets
import subprocess
import threading
import time
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError

from app.broker.base import BrokerError, Order, OrderRequest
from app.broker.ratelimit import Cancelled
from app.market.feeds import FeedUnavailable
from app.market.hub import MarketHub
from app.market.instruments import Instrument, registry
from app.scripts.candles import STEPS, CandleBuilder
from app.scripts.performance import RunPerformance
from app.scripts.runtime import NO_WINDOW, ScriptRuntime
from app.scripts.store import ScriptError, ScriptStore, check_syntax, script_defaults

log = logging.getLogger(__name__)

MAX_SYMBOLS = 20
MAX_ACTIVE_RUNS = 10
HISTORY_BARS = 300
HISTORY_DAYS = {"1m": 2, "5m": 10, "15m": 30, "1h": 90, "1d": 730}
ORDERS_PER_MINUTE = 10
LOG_LINES_PER_SECOND = 50
READY_TIMEOUT = 30
ACTIVE_STATES = {"starting", "running", "stopping"}


@dataclass
class RunInfo:
    id: str
    script: str
    symbols: list[str]
    interval: str
    state: str = "starting"  # starting | running | stopping | stopped | finished | failed
    message: str = ""
    started_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())
    ended_at: str | None = None
    candles: int = 0
    orders: int = 0
    errors: int = 0

    @property
    def tag(self) -> str:
        return f"qvrun{self.id}"

    def to_dict(self) -> dict:
        return {**asdict(self), "tag": self.tag, "active": self.state in ACTIVE_STATES}


class Run:
    def __init__(self, mgr: "RunManager", info: RunInfo, script_path: Path, instruments: list[Instrument]) -> None:
        self.mgr = mgr
        self.info = info
        self.script_path = script_path
        self.instruments = instruments
        self.universe = [i.symbol for i in instruments]
        self.proc: subprocess.Popen | None = None
        self.outbox: queue.Queue[dict | None] = queue.Queue()
        self.logs: deque[dict] = deque(maxlen=2000)
        self._seq = 0
        self._order_ids: set[str] = set()
        self._order_times: deque[float] = deque()
        self._log_window = (0.0, 0, 0)  # (second, lines, dropped)
        self._stopping = threading.Event()
        self._fatal: str | None = None
        self._unsubs: list = []
        self._lock = threading.RLock()
        self.perf = RunPerformance(instruments, lambda s: (t.ltp if (t := mgr.hub.last_tick(s)) else None))
        log_dir = mgr.logs_dir
        log_dir.mkdir(parents=True, exist_ok=True)
        self._logfile = (log_dir / f"{script_path.stem}-{info.id}.log").open("a", encoding="utf-8")

    # --- lifecycle --------------------------------------------------------------------------

    def start(self) -> None:
        threading.Thread(target=self._main, name=f"run-{self.info.id}", daemon=True).start()

    def _main(self) -> None:
        try:
            history = self._load_history()
            self.perf.set_history(history)
            if self._stopping.is_set():
                return
            self._spawn()
            self.outbox.put({"type": "init", "run_id": self.info.id, "symbols": self.universe, "interval": self.info.interval,
                             "mode": self.mgr.engine.trading_mode, "history": history})
            self._read_loop()
        except Cancelled:
            pass
        except Exception as e:
            log.exception("run %s crashed", self.info.id)
            self._fatal = self._fatal or str(e)
        finally:
            self._finish()

    def _load_history(self) -> dict[str, list[dict]]:
        feed = self.mgr.engine.feed
        if feed is None:
            raise RuntimeError("Engine is locked")
        self.mgr.engine.ensure_streaming(self.instruments)
        history = {}
        for n, inst in enumerate(self.instruments, 1):
            self._set(message=f"Loading history {n}/{len(self.instruments)}…")
            try:
                bars = feed.candles(inst, self.info.interval, HISTORY_DAYS[self.info.interval], abort=self._stopping)
            except FeedUnavailable as e:
                self.log("warning", f"No history for {inst.symbol} ({e}); indicators start empty")
                bars = []
            history[inst.symbol] = bars[-HISTORY_BARS:]
        return history

    def _spawn(self) -> None:
        runtime: ScriptRuntime = self.mgr.runtime
        self.proc = subprocess.Popen(
            [str(runtime.python), "-u", "-m", "quantvision.runner", str(self.script_path)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            cwd=self.script_path.parent, env=runtime.child_env(), creationflags=NO_WINDOW,
        )
        threading.Thread(target=self._writer, name=f"run-{self.info.id}-in", daemon=True).start()
        threading.Thread(target=self._stderr_reader, name=f"run-{self.info.id}-err", daemon=True).start()
        threading.Thread(target=self._ready_watchdog, name=f"run-{self.info.id}-wd", daemon=True).start()

    def _writer(self) -> None:
        while True:
            msg = self.outbox.get()
            if msg is None or self.proc is None or self.proc.poll() is not None:
                return
            try:
                self.proc.stdin.write(json.dumps(msg, default=str) + "\n")
                self.proc.stdin.flush()
            except (OSError, ValueError):
                return

    def _stderr_reader(self) -> None:
        for line in self.proc.stderr:
            if line.strip():
                self.log("error", line.rstrip())

    def _ready_watchdog(self) -> None:
        deadline = time.monotonic() + READY_TIMEOUT
        while time.monotonic() < deadline:
            if self.info.state != "starting" or self._stopping.is_set():
                return
            time.sleep(0.2)
        self._fatal = f"The script didn't start within {READY_TIMEOUT}s"
        self._kill()

    def _read_loop(self) -> None:
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                self.log("info", line.rstrip())
                continue
            kind = msg.get("type")
            if kind == "ready":
                self._on_ready()
            elif kind == "log":
                self.log(msg.get("level", "info"), str(msg.get("text", "")))
            elif kind == "error":
                with self._lock:
                    self.info.errors += 1
                self.log("error", f"Error in {msg.get('where', 'script')}:\n{msg.get('text', '')}")
                self.mgr.broadcast(self)
            elif kind == "fatal":
                self._fatal = str(msg.get("text", "Script stopped"))
                self.log("error", self._fatal)
            elif kind == "request":
                self.outbox.put(self._handle_request(msg))
        self.proc.wait()

    def _on_ready(self) -> None:
        for inst in self.instruments:
            self._unsubs.append(self.mgr.builder.subscribe(inst.symbol, self.info.interval, self._on_candle))
        self._set(state="running", message="")
        self.log("info", f"Running on {', '.join(self.universe)} ({self.info.interval} candles), {self.mgr.engine.trading_mode} mode")

    def stop(self, reason: str = "") -> None:
        if self._stopping.is_set():
            return
        self._stopping.set()
        if self.info.state in ACTIVE_STATES:
            self._set(state="stopping", message=reason)
        self.outbox.put({"type": "stop"})
        threading.Thread(target=self._stop_watchdog, daemon=True).start()

    def _stop_watchdog(self) -> None:
        # Give on_stop a moment, then make sure the process is gone.
        for _ in range(30):
            if self.proc is None or self.proc.poll() is not None:
                return
            time.sleep(0.1)
        self._kill()

    def _kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()

    def _finish(self) -> None:
        for unsub in self._unsubs:
            unsub()
        self.outbox.put(None)
        self._kill()
        code = self.proc.returncode if self.proc else None
        if self._stopping.is_set():
            state, message = "stopped", self.info.message
        elif self._fatal:
            state, message = "failed", self._fatal.splitlines()[-1] if self._fatal else ""
        elif code not in (0, None):
            state, message = "failed", f"Script process exited with code {code}"
        else:
            state, message = "finished", ""
        self.perf.sample()
        self._set(state=state, message=message, ended_at=datetime.now(UTC).isoformat())
        self.log("info", f"Run {state}{': ' + message if message else ''}")
        self._logfile.close()
        self.mgr.on_run_end(self)

    # --- engine -> script -------------------------------------------------------------------

    def _on_candle(self, symbol: str, interval: str, candle: dict) -> None:
        if self.info.state == "running":
            with self._lock:
                self.info.candles += 1
            self.perf.on_candle(symbol, candle)
            self.outbox.put({"type": "candle", "symbol": symbol, "candle": candle})

    def on_order(self, order: Order) -> None:
        # Match by tag too: an instant paper fill is announced before place_order returns its id.
        mine = order.order_id in self._order_ids or order.source == self.info.tag
        if not mine:
            return
        with self._lock:
            self._order_ids.add(order.order_id)
        self.perf.on_order(order)  # fills after a stop still count towards the run's results
        if self.info.state == "running":
            self.outbox.put({"type": "order", "order": order.to_dict()})

    def on_mode(self, mode: str) -> None:
        if self.info.state == "running":
            self.outbox.put({"type": "mode", "mode": mode})
            self.log("warning", f"Trading mode switched to {mode.upper()}: this script's next orders are {mode}")

    # --- script -> engine ---------------------------------------------------------------------

    def _handle_request(self, msg: dict) -> dict:
        rid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        try:
            result = self._dispatch(method, params)
            return {"type": "reply", "id": rid, "ok": True, "result": result}
        except (BrokerError, ValueError) as e:
            return {"type": "reply", "id": rid, "ok": False, "error": str(e)}
        except Exception as e:
            log.exception("run %s request %s failed", self.info.id, method)
            return {"type": "reply", "id": rid, "ok": False, "error": f"{method} failed: {e}"}

    def _symbol(self, params: dict) -> str:
        sym = str(params.get("symbol") or "").upper()
        if sym not in self.universe:
            raise ValueError(f"{sym} isn't in this run's symbols")
        return sym

    def _dispatch(self, method: str, params: dict):
        engine = self.mgr.engine
        if method == "order":
            return self._place(params)
        if method == "position":
            return engine.position(self._symbol(params))
        if method == "ltp":
            tick = self.mgr.hub.last_tick(self._symbol(params))
            return tick.ltp if tick else None
        if method == "funds":
            return engine.broker.funds().to_dict()
        if method == "orders":
            return [o.to_dict() for o in engine.broker.orders() if o.order_id in self._order_ids]
        if method == "cancel":
            order_id = str(params.get("order_id"))
            if order_id not in self._order_ids:
                raise ValueError(f"Order {order_id} wasn't placed by this run")
            engine.cancel_order(order_id)
            return None
        if method == "cancel_all":
            cancelled = 0
            for o in engine.broker.orders():
                if o.order_id in self._order_ids and o.is_open:
                    engine.cancel_order(o.order_id)
                    cancelled += 1
            return cancelled
        raise ValueError(f"Unknown request {method}")

    def _place(self, params: dict) -> dict:
        symbol = self._symbol(params)
        side, qty = params.get("side"), params.get("quantity")

        def rejected(message: str) -> dict:
            self.perf.order_rejected_before_broker()
            self.log("warning", f"{side} {qty} {symbol} rejected: {message}")
            return {"order_id": "", "symbol": symbol, "side": side, "order_type": params.get("order_type"), "product": params.get("product"),
                    "quantity": qty, "filled_quantity": 0, "price": params.get("price"), "trigger_price": params.get("trigger_price"),
                    "average_price": None, "status": "rejected", "message": message}

        now = time.monotonic()
        with self._lock:
            while self._order_times and now - self._order_times[0] > 60:
                self._order_times.popleft()
            over_limit = len(self._order_times) >= ORDERS_PER_MINUTE
            if not over_limit:
                self._order_times.append(now)
        if over_limit:  # rejected() logs, which takes the lock: call it outside
            return rejected(f"this script hit its limit of {ORDERS_PER_MINUTE} orders per minute")
        try:
            req = OrderRequest(symbol=symbol, side=side, quantity=qty, order_type=params.get("order_type") or "MARKET",
                               product=params.get("product") or "DELIVERY", price=params.get("price"),
                               trigger_price=params.get("trigger_price"), tag=self.info.tag)
        except ValidationError as e:
            return rejected(e.errors()[0]["msg"].replace("Value error, ", ""))
        try:
            order = self.mgr.engine.place_order(req)
        except BrokerError as e:
            return rejected(str(e))
        with self._lock:
            self._order_ids.add(order.order_id)
            self.info.orders += 1
        self.perf.order_placed()
        self.perf.on_order(order)
        fill = f" @ ₹{order.average_price:,.2f}" if order.average_price else ""
        self.log("info", f"{order.side} {order.quantity} {symbol} {order.order_type} → {order.status}{fill} ({order.order_id})")
        self.mgr.broadcast(self)
        return order.to_dict()

    # --- logs & status --------------------------------------------------------------------------

    def log(self, level: str, text: str) -> None:
        now = time.time()
        second, lines, dropped = self._log_window
        if int(now) != second:
            if dropped:
                self._append("warning", f"… {dropped} log lines dropped (more than {LOG_LINES_PER_SECOND}/s)", now)
            second, lines, dropped = int(now), 0, 0
        if lines >= LOG_LINES_PER_SECOND:
            self._log_window = (second, lines, dropped + 1)
            return
        self._log_window = (second, lines + 1, dropped)
        self._append(level, text, now)

    def _append(self, level: str, text: str, now: float) -> None:
        with self._lock:
            self._seq += 1
            entry = {"seq": self._seq, "ts": now, "level": level, "text": text}
            self.logs.append(entry)
        try:
            stamp = datetime.fromtimestamp(now).strftime("%Y-%m-%d %H:%M:%S")
            self._logfile.write(f"{stamp} {level.upper():7} {text}\n")
            self._logfile.flush()
        except (OSError, ValueError):
            pass
        self.mgr.hub.broadcast_threadsafe({"type": "script_log", "run_id": self.info.id, "entry": entry})

    def _set(self, **changes) -> None:
        with self._lock:
            for k, v in changes.items():
                setattr(self.info, k, v)
        self.mgr.broadcast(self)


class RunManager:
    def __init__(self, engine, hub: MarketHub, store: ScriptStore, runtime: ScriptRuntime, builder: CandleBuilder, logs_dir: Path) -> None:
        self.engine = engine
        self.hub = hub
        self.store = store
        self.runtime = runtime
        self.builder = builder
        self.logs_dir = logs_dir
        self._runs: dict[str, Run] = {}
        self._lock = threading.Lock()
        engine.order_listeners.append(self._on_order)
        engine.mode_listeners.append(self._on_mode)
        engine.stop_listeners.append(lambda: self.stop_all("Signed out"))

    # --- queries ----------------------------------------------------------------------------------

    def list(self) -> list[dict]:
        with self._lock:
            runs = list(self._runs.values())
        return [r.info.to_dict() for r in sorted(runs, key=lambda r: r.info.started_at, reverse=True)]

    def get(self, run_id: str) -> Run:
        run = self._runs.get(run_id)
        if run is None:
            raise KeyError(run_id)
        return run

    def logs(self, run_id: str, after: int = 0) -> list[dict]:
        run = self.get(run_id)
        with run._lock:
            return [e for e in run.logs if e["seq"] > after]

    def active(self) -> list[Run]:
        with self._lock:
            return [r for r in self._runs.values() if r.info.state in ACTIVE_STATES]

    # --- control ------------------------------------------------------------------------------------

    def start(self, script: str, symbols: list[str], interval: str) -> RunInfo:
        if not self.engine.running:
            raise ScriptError("Engine is locked; sign in first")
        if self.runtime.check() != "ready":
            self.runtime.ensure()
            raise ScriptError(self.runtime.message or "The script environment is still being set up; try again shortly")
        if interval not in STEPS:
            raise ScriptError(f"Interval must be one of {', '.join(STEPS)}")
        symbols = list(dict.fromkeys(s.strip().upper() for s in symbols if s.strip()))
        if not symbols:
            raise ScriptError("Choose at least one symbol")
        if len(symbols) > MAX_SYMBOLS:
            raise ScriptError(f"A run can watch at most {MAX_SYMBOLS} symbols")
        instruments = []
        for s in symbols:
            inst = registry.get(s)
            if inst is None:
                raise ScriptError(f"Unknown symbol {s}")
            instruments.append(inst)
        source = self.store.read(script)
        if err := check_syntax(source, script):
            raise ScriptError(f"Syntax error: {err}")
        if not script_defaults(source)["has_on_candle"]:
            raise ScriptError("The script must define on_candle(candle, indicators, api)")
        if len(self.active()) >= MAX_ACTIVE_RUNS:
            raise ScriptError(f"At most {MAX_ACTIVE_RUNS} scripts can run at once")

        info = RunInfo(id=secrets.token_hex(4), script=script, symbols=[i.symbol for i in instruments], interval=interval)
        run = Run(self, info, self.store.path(script), instruments)
        with self._lock:
            self._runs[info.id] = run
            self._prune()
        run.log("info", f"Starting {script}")
        self.broadcast(run)
        run.start()
        return info

    def stop(self, run_id: str) -> None:
        self.get(run_id).stop("Stopped by you")

    def stop_all(self, reason: str) -> int:
        runs = self.active()
        for r in runs:
            r.stop(reason)
        return len(runs)

    def kill_switch(self) -> dict:
        """Emergency stop: every script, then every open order."""
        stopped = self.stop_all("Kill switch")
        orders = self.engine.cancel_all() if self.engine.running else {"cancelled": [], "failed": []}
        log.warning("KILL SWITCH: stopped %d scripts, cancelled %d orders", stopped, len(orders["cancelled"]))
        return {"stopped_runs": stopped, **orders}

    # --- plumbing ---------------------------------------------------------------------------------

    def broadcast(self, run: Run) -> None:
        self.hub.broadcast_threadsafe({"type": "script_run", "run": run.info.to_dict()})

    def on_run_end(self, run: Run) -> None:
        self.broadcast(run)

    def _prune(self) -> None:
        finished = sorted((r for r in self._runs.values() if r.info.state not in ACTIVE_STATES), key=lambda r: r.info.started_at)
        for r in finished[:-20]:
            del self._runs[r.info.id]

    def performance(self, run_id: str, symbol: str | None = None) -> dict:
        return self.get(run_id).perf.snapshot(symbol)

    def _on_order(self, order: Order) -> None:
        with self._lock:
            runs = list(self._runs.values())
        for run in runs:
            run.on_order(order)

    def _on_mode(self, mode: str) -> None:
        for run in self.active():
            run.on_mode(mode)
