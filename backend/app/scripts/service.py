"""Shared instances of the scripting subsystem."""

from app.backtest.manager import BacktestManager
from app.config import settings
from app.engine import engine
from app.market.hub import hub
from app.scripts.candles import CandleBuilder
from app.scripts.runs import RunManager
from app.scripts.runtime import ScriptRuntime
from app.scripts.store import ScriptStore

store = ScriptStore(settings.home_dir / "scripts")
runtime = ScriptRuntime(settings.home_dir / "runtime")
builder = CandleBuilder()
runs = RunManager(engine, hub, store, runtime, builder, settings.home_dir / "logs" / "scripts")
backtests = BacktestManager(store, runtime, settings.home_dir / "backtests", settings.home_dir / "data_cache")


def start() -> None:
    hub.add_tick_listener(builder.on_tick)
    builder.start()
    # One-time setup of the isolated script environment, in the background.
    runtime.ensure()


def stop() -> None:
    runs.stop_all("Engine shutting down")
    backtests.stop_all()
    builder.stop()
