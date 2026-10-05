"""Runs backtests: prepares data, runs `quantvision.backtest` in the script environment, keeps results.

One backtest runs at a time (they're CPU-bound). Each result is saved as JSON in
QV_HOME/backtests/<id>.json together with the exact script it ran, so it can be reopened later.
"""

import json
import logging
import secrets
import shutil
import subprocess
import threading
from collections import deque
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path

from app.backtest import data as data_mod
from app.market.instruments import Instrument, registry
from app.scripts.runtime import NO_WINDOW, ScriptRuntime
from app.scripts.store import ScriptStore, check_syntax, script_defaults

log = logging.getLogger(__name__)

MAX_SYMBOLS = 20
MAX_KEPT = 50  # saved backtests
MAX_LOGS = 5000
TIME_LIMIT = 30 * 60  # seconds
READY_TIMEOUT = 60
ACTIVE = ("preparing", "running")
SUMMARY_KEYS = ("final_value", "net_pnl", "total_return_pct", "cagr_pct", "sharpe", "max_drawdown_pct", "win_rate_pct", "trades", "total_charges", "benchmark_return_pct")


class BacktestError(ValueError):
    pass


@dataclass
class BacktestInfo:
    id: str
    script: str
    symbols: list[str]
    interval: str
    start: str
    end: str
    capital: float
    slippage_pct: float
    charges: dict
    state: str = "preparing"  # preparing | running | done | error | cancelled
    message: str = ""
    progress: float = 0.0
    created_at: str = field(default_factory=lambda: datetime.now().astimezone().isoformat(timespec="seconds"))
    finished_at: str | None = None
    summary: dict | None = None

    def to_dict(self) -> dict:
        return asdict(self)


class Backtest:
    def __init__(self, mgr: "BacktestManager", info: BacktestInfo, code: str, instruments: list[Instrument]) -> None:
        self.mgr = mgr
        self.info = info
        self.code = code
        self.instruments = instruments
        self.logs: deque[dict] = deque(maxlen=MAX_LOGS)
        self.log_count = 0
        self.result: dict | None = None
        self.proc: subprocess.Popen | None = None
        self._cancel = threading.Event()
        self._lock = threading.Lock()
        self.workdir = mgr.root / "tmp" / info.id

    def log(self, level: str, text: str, when: str | None = None) -> None:
        with self._lock:
            self.log_count += 1
            self.logs.append({"n": self.log_count, "level": level, "text": text, "time": when})

    def _set(self, **changes) -> None:
        with self._lock:
            for k, v in changes.items():
                setattr(self.info, k, v)

    def cancel(self) -> None:
        self._cancel.set()
        self._kill()

    def _kill(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    # --- the run ------------------------------------------------------------------------------

    def run(self) -> None:
        try:
            self._run()
        except data_mod.DataError as e:
            self._finish("error", str(e))
        except Exception as e:  # noqa: BLE001
            log.exception("backtest %s failed", self.info.id)
            self._finish("error", f"Backtest failed: {e}")
        finally:
            shutil.rmtree(self.workdir, ignore_errors=True)

    def _run(self) -> None:
        i = self.info
        start, end = date.fromisoformat(i.start), date.fromisoformat(i.end)
        prepared = data_mod.prepare(self.mgr.cache, self.instruments, i.interval, start, end, progress=lambda text: self._set(message=text))
        for w in prepared.warnings:
            self.log("warning", w)
        if self._cancel.is_set():
            return self._finish("cancelled", "Cancelled")

        self.workdir.mkdir(parents=True, exist_ok=True)
        paths = {}
        for sym, df in prepared.frames.items():
            p = self.workdir / f"{len(paths)}.parquet"
            df.to_parquet(p)
            paths[sym] = str(p)
        bench = None
        if prepared.benchmark is not None:
            bench = self.workdir / "benchmark.parquet"
            prepared.benchmark.to_parquet(bench)
        script = self.workdir / "strategy.py"  # the exact code this backtest runs, even if the file is edited meanwhile
        script.write_text(self.code, encoding="utf-8")

        init = {
            "type": "init", "symbols": i.symbols, "interval": i.interval, "start": i.start, "end": i.end,
            "capital": i.capital, "slippage_pct": i.slippage_pct, "charges": i.charges,
            "data": paths, "benchmark": str(bench) if bench else None,
            "exchanges": {inst.symbol: inst.exchange for inst in self.instruments},
            "indices": [inst.symbol for inst in self.instruments if inst.is_index],
        }
        self._set(state="running", message="Starting the simulation", progress=0.0)
        runtime: ScriptRuntime = self.mgr.runtime
        self.proc = subprocess.Popen(
            [str(runtime.python), "-u", "-m", "quantvision.backtest", str(script)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            cwd=self.mgr.store.path(self.info.script).parent, env=runtime.child_env(), creationflags=NO_WINDOW,
        )
        stderr_tail: deque[str] = deque(maxlen=20)
        threading.Thread(target=lambda: stderr_tail.extend(self.proc.stderr), daemon=True).start()
        watchdog = threading.Timer(TIME_LIMIT, self._timeout)
        watchdog.daemon = True
        watchdog.start()
        try:
            self.proc.stdin.write(json.dumps(init) + "\n")
            self.proc.stdin.flush()
            self.proc.stdin.close()
        except OSError:
            pass
        fatal = None
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            kind = msg.get("type")
            if kind == "log":
                self.log(msg.get("level", "info"), msg.get("text", ""), msg.get("time"))
            elif kind == "error":
                self.log("error", f"Error in {msg.get('where')}:\n{msg.get('text', '')}")
            elif kind == "progress":
                total = max(int(msg.get("total") or 1), 1)
                self._set(progress=min(1.0, int(msg.get("done") or 0) / total), message=f"Simulating candle {msg.get('done')} of {total}")
            elif kind == "ready":
                self._set(message="Simulating")
            elif kind == "fatal":
                fatal = msg.get("text", "The script stopped")
            elif kind == "result":
                self.result = msg.get("result")
        self.proc.wait()
        watchdog.cancel()

        if self._cancel.is_set():
            return self._finish("cancelled", self.info.message if self.info.message.startswith("Stopped") else "Cancelled")
        if self.result is not None:
            self.result["warnings"] = [*prepared.warnings, *self.result.get("warnings", [])]
            return self._finish("done", "")
        detail = fatal or "".join(stderr_tail).strip()[-800:] or f"The backtest process exited with code {self.proc.returncode}"
        self.log("error", detail)
        self._finish("error", detail.splitlines()[0] if fatal is None else fatal.splitlines()[0])

    def _timeout(self) -> None:
        self._set(message=f"Stopped: the backtest took longer than {TIME_LIMIT // 60} minutes")
        self._cancel.set()
        self._kill()

    def _finish(self, state: str, message: str) -> None:
        summary = None
        if self.result:
            s = self.result.get("summary", {})
            summary = {k: s.get(k) for k in SUMMARY_KEYS}
        final = {"state": state, "message": message, "finished_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                 "summary": summary, "progress": 1.0 if state == "done" else self.info.progress}
        self.mgr.save(self, {**self.info.to_dict(), **final})  # saved first, so a finished backtest always has its file
        self._set(**final)


class BacktestManager:
    def __init__(self, store: ScriptStore, runtime: ScriptRuntime, root: Path, cache_dir: Path) -> None:
        self.store = store
        self.runtime = runtime
        self.root = root
        self.cache = data_mod.HistoryCache(cache_dir)
        self._active: Backtest | None = None
        self._recent: dict[str, Backtest] = {}
        self._lock = threading.Lock()

    # --- control ------------------------------------------------------------------------------

    def start(self, script: str, symbols: list[str], interval: str, start: str, end: str, capital: float,
              slippage_pct: float, charges: dict) -> BacktestInfo:
        if self.runtime.check() != "ready":
            self.runtime.ensure()
            raise BacktestError(self.runtime.message or "The script environment is still being set up; try again shortly")
        symbols = list(dict.fromkeys(s.strip().upper() for s in symbols if s.strip()))
        if not symbols:
            raise BacktestError("Choose at least one stock")
        if len(symbols) > MAX_SYMBOLS:
            raise BacktestError(f"A backtest can include at most {MAX_SYMBOLS} stocks")
        try:
            d0, d1 = date.fromisoformat(start), date.fromisoformat(end)
        except ValueError as e:
            raise BacktestError("Dates must look like 2024-01-31") from e
        data_mod.validate_range(interval, d0, d1)
        if not 1_000 <= capital <= 1e11:
            raise BacktestError("Initial capital must be between ₹1,000 and ₹10,000 crore")
        if not 0 <= slippage_pct <= 5:
            raise BacktestError("Slippage must be between 0% and 5%")
        instruments = []
        for s in symbols:
            inst = registry.get(s)
            if inst is None:
                raise BacktestError(f"Unknown symbol {s}")
            data_mod.yahoo_ticker(inst)  # fails early for indices Yahoo doesn't have
            instruments.append(inst)
        if all(i.is_index for i in instruments):
            raise BacktestError("Add at least one stock; indices can be watched but not traded")
        code = self.store.read(script)
        if err := check_syntax(code, script):
            raise BacktestError(f"Syntax error: {err}")
        if not script_defaults(code)["has_on_candle"]:
            raise BacktestError("The script must define on_candle(candle, indicators, api)")
        with self._lock:
            if self._active and self._active.info.state in ACTIVE:
                raise BacktestError("Another backtest is running; wait for it or cancel it")
            info = BacktestInfo(id=secrets.token_hex(4), script=script, symbols=[i.symbol for i in instruments], interval=interval,
                                start=d0.isoformat(), end=d1.isoformat(), capital=float(capital), slippage_pct=float(slippage_pct),
                                charges=charges or {})
            bt = Backtest(self, info, code, instruments)
            self._active = bt
            self._recent[info.id] = bt
        bt.log("info", f"Backtesting {script} on {', '.join(info.symbols)} ({interval} candles, {info.start} to {info.end})")
        threading.Thread(target=bt.run, name=f"backtest-{info.id}", daemon=True).start()
        return info

    def cancel(self, backtest_id: str) -> None:
        bt = self._recent.get(backtest_id)
        if bt is None or bt.info.state not in ACTIVE:
            raise BacktestError("That backtest isn't running")
        bt.cancel()

    def stop_all(self) -> None:
        if self._active and self._active.info.state in ACTIVE:
            self._active.cancel()

    # --- results ------------------------------------------------------------------------------

    def _path(self, backtest_id: str) -> Path:
        if not backtest_id.isalnum():
            raise BacktestError("Invalid backtest id")
        return self.root / f"{backtest_id}.json"

    def save(self, bt: Backtest, info: dict) -> None:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = {"info": info, "code": bt.code, "result": bt.result, "logs": list(bt.logs), "log_count": bt.log_count}
        tmp = self._path(bt.info.id).with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, default=str), encoding="utf-8")
        tmp.replace(self._path(bt.info.id))
        self._prune()

    def _prune(self) -> None:
        files = sorted(self.root.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in files[MAX_KEPT:]:
            old.unlink(missing_ok=True)
            self._recent.pop(old.stem, None)

    def list(self, script: str | None = None) -> list[dict]:
        out = {}
        if self.root.exists():
            for p in self.root.glob("*.json"):
                try:
                    info = json.loads(p.read_text(encoding="utf-8"))["info"]
                except (OSError, ValueError, KeyError):
                    continue
                out[info["id"]] = info
        for bt in list(self._recent.values()):
            out[bt.info.id] = bt.info.to_dict()
        rows = [r for r in out.values() if script is None or r["script"] == script]
        return sorted(rows, key=lambda r: r["created_at"], reverse=True)

    def get(self, backtest_id: str, logs_after: int = 0) -> dict:
        bt = self._recent.get(backtest_id)
        path = self._path(backtest_id)
        if bt is not None and bt.info.state in ACTIVE:
            with bt._lock:
                return {"info": bt.info.to_dict(), "logs": [l for l in bt.logs if l["n"] > logs_after], "log_count": bt.log_count, "result": None, "code": None}
        if not path.exists():
            raise FileNotFoundError(backtest_id)
        payload = json.loads(path.read_text(encoding="utf-8"))
        payload["logs"] = [l for l in payload.get("logs", []) if l["n"] > logs_after]
        return payload

    def delete(self, backtest_id: str) -> None:
        bt = self._recent.get(backtest_id)
        if bt is not None and bt.info.state in ACTIVE:
            raise BacktestError("Cancel the backtest before deleting it")
        self._recent.pop(backtest_id, None)
        path = self._path(backtest_id)
        if not path.exists():
            raise FileNotFoundError(backtest_id)
        path.unlink()

