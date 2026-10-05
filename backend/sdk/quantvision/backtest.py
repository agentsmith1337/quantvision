"""Child-process entry point for backtests: runs an unchanged on_candle script with Backtrader.

    python -m quantvision.backtest <script.py>

The engine sends one `init` JSON line (universe, interval, dates, capital, costs and the paths of
Parquet files holding each stock's candles, including warm-up history before the start date).
We answer with JSON lines: log / error / progress, then `result` (or `fatal`).

How a backtest mirrors live trading:
* on_candle(candle, indicators, api) runs once per closed candle per stock, in universe order,
  and only sees candles up to that one (indicators get a moving window; nothing from the future).
* Orders fill on a later candle: market orders at the next candle's open (plus slippage); limit and
  stop orders when a later candle reaches their price. Orders are DAY orders.
* DELIVERY needs cash for buys and holdings for sells; INTRADAY needs 20% margin, allows short
  selling, and is squared off automatically at 15:15. Angel One's charges are deducted per fill.
"""

import math
import sys
import time
from datetime import datetime, time as dtime

import backtrader as bt
import pandas as pd

from quantvision import charges as charges_mod
from quantvision.api import Api
from quantvision.indicators import MAX_ROWS, Indicators
from quantvision.ledger import Ledger, trade_stats
from quantvision.models import IST, Candle, Order
from quantvision.runner import Runner, _LogStream

INTRADAY_INTERVALS = {"1m", "5m", "15m", "1h"}
SQUARE_OFF = dtime(15, 15)
MAX_LOG_LINES = 20_000
MAX_EQUITY_POINTS = 1500
MAX_FILLS = 10_000
# Backtrader's broker gets this much extra cash so it never refuses a fill: QuantVision applies
# its own cash/margin rules (Simulation._check) and subtracts the offset from every value.
CASH_OFFSET = 1e10
OPEN_STATES = {"open", "trigger pending"}


def _iso(ts: pd.Timestamp | datetime) -> str:
    return pd.Timestamp(ts).tz_localize(IST).isoformat() if pd.Timestamp(ts).tzinfo is None else pd.Timestamp(ts).isoformat()


class Simulation:
    """The broker the script talks to through `api`, on top of Backtrader's order matching."""

    def __init__(self, runner: "BacktestRunner", cfg: dict, frames: dict[str, pd.DataFrame]) -> None:
        self.r = runner
        self.cfg = cfg
        self.universe: list[str] = cfg["symbols"]
        self.interval: str = cfg["interval"]
        self.intraday = self.interval in INTRADAY_INTERVALS
        self.capital = float(cfg["capital"])
        self.margin = float(cfg.get("intraday_margin", 0.2))
        self.exchanges: dict[str, str] = cfg.get("exchanges", {})
        self.indices = set(cfg.get("indices", []))
        self.charge_cfg = charges_mod.config(cfg.get("charges"))
        self.frames = frames  # full history per stock (naive IST index, as Backtrader needs), including warm-up
        # What indicators see: the same candles with an IST-aware index, exactly like a live run.
        self.aware = {s: f.tz_localize(IST) for s, f in frames.items()}
        start, end = pd.Timestamp(cfg["start"]), pd.Timestamp(cfg["end"]) + pd.Timedelta(days=1)
        self.sim = {s: f[(f.index >= start) & (f.index < end)] for s, f in frames.items()}
        timeline = sorted(set().union(*(f.index for f in self.sim.values())))
        self.timeline = pd.DatetimeIndex(timeline)
        self.next_ts = {ts: (timeline[i + 1] if i + 1 < len(timeline) else None) for i, ts in enumerate(timeline)}
        self.positions_in_full = {s: {ts: i for i, ts in enumerate(f.index)} for s, f in frames.items()}

        self.ledger = Ledger()
        self.orders: dict[str, dict] = {}  # our id -> order dict (the Order model's fields + extras)
        self.bt_orders: dict[str, bt.Order] = {}
        self.by_ref: dict[int, str] = {}
        self.fills: list[dict] = []
        self.fill_count = 0
        self.total_charges = 0.0
        self.charge_totals = charges_mod.Charges()
        self.equity: list[tuple[pd.Timestamp, float]] = []
        self.exposed_bars = 0
        self.now: pd.Timestamp | None = None
        self.squared_sessions: set = set()
        self.warnings: list[str] = []
        self.strategy: bt.Strategy | None = None
        self._seq = 0

    # --- time & prices --------------------------------------------------------------------

    def last_close(self, symbol: str) -> float | None:
        view = self.r.indicators._frames.get(symbol)
        return float(view["close"].iloc[-1]) if view is not None and len(view) else None

    def equity_now(self) -> float:
        return self.strategy.broker.getvalue() - CASH_OFFSET - self.total_charges

    def _eligible_session(self):
        """The trading day an order placed now can first fill in."""
        if self.now is None:
            return self.timeline[0].date() if len(self.timeline) else None
        nxt = self.next_ts.get(self.now)
        if nxt is None:
            return None
        return nxt.date() if self._session_end(self.now) else self.now.date()

    def _session_end(self, ts: pd.Timestamp) -> bool:
        nxt = self.next_ts.get(ts)
        return nxt is None or nxt.date() != ts.date()

    def _square_off_bar(self, ts: pd.Timestamp) -> bool:
        """The candle whose close is the last chance to queue square-off orders (they fill at ~15:15)."""
        if not self.intraday:
            return False
        nxt = self.next_ts.get(ts)
        if nxt is not None and nxt.date() == ts.date():
            return ts.time() < SQUARE_OFF <= nxt.time()
        return ts.date() not in self.squared_sessions  # session ended early: square off at its last candle

    # --- the api's requests --------------------------------------------------------------------

    def call(self, method: str, params: dict):
        handler = getattr(self, f"_api_{method}", None)
        if handler is None:
            raise RuntimeError(f"{method} isn't available in backtests")
        return handler(**params)

    def _api_ltp(self, symbol: str):
        return self.last_close(symbol)

    def _api_position(self, symbol: str) -> int:
        return self.ledger.qty(symbol, "DELIVERY") + self.ledger.qty(symbol, "INTRADAY")

    def _api_funds(self) -> dict:
        return {"available_cash": round(self._available(), 2), "used_margin": round(self._used_margin(), 2), "net": round(self.equity_now(), 2)}

    def _api_orders(self) -> list[dict]:
        today = self.now.date() if self.now is not None else None
        return [self._public(o) for o in self.orders.values() if o["_session"] == today or o["status"] in OPEN_STATES]

    def _api_cancel(self, order_id: str) -> None:
        o = self.orders.get(order_id)
        if o is None:
            raise RuntimeError(f"No order {order_id} in this backtest")
        if o["status"] in OPEN_STATES:
            self.strategy.cancel(self.bt_orders[order_id])

    def _api_cancel_all(self) -> int:
        n = 0
        for oid, o in self.orders.items():
            if o["status"] in OPEN_STATES:
                self.strategy.cancel(self.bt_orders[oid])
                n += 1
        return n

    def _used_margin(self) -> float:
        return sum(abs(b.qty) * b.avg * self.margin for (_, p), b in self.ledger.books.items() if p == "INTRADAY")

    def _available(self) -> float:
        held = sum(b.qty * (self.last_close(s) or b.avg) for (s, p), b in self.ledger.books.items() if p == "DELIVERY")
        return self.equity_now() - held - self._used_margin()

    def _api_order(self, side, quantity, symbol, order_type, price, trigger_price, product, auto=False) -> dict:
        self._seq += 1
        oid = f"BT{self._seq}"
        o = {
            "order_id": oid, "symbol": symbol, "side": side, "order_type": order_type, "product": product,
            "quantity": quantity, "filled_quantity": 0, "price": price, "trigger_price": trigger_price,
            "average_price": None, "status": "open", "message": "",
            "_session": self._eligible_session(), "_placed": _iso(self.now) if self.now is not None else None, "_auto": auto,
        }
        self.orders[oid] = o
        problem = self._check(o)
        if problem:
            o["status"], o["message"] = "rejected", problem
            return self._public(o)

        data = self.strategy.getdatabyname(symbol)
        kwargs = {"data": data, "size": quantity}
        if order_type == "MARKET":
            kwargs["exectype"] = bt.Order.Market
        elif order_type == "LIMIT":
            kwargs.update(exectype=bt.Order.Limit, price=price)
        elif order_type == "SL-M":
            kwargs.update(exectype=bt.Order.Stop, price=trigger_price)
            o["status"] = "trigger pending"
        else:  # SL: stop-limit
            kwargs.update(exectype=bt.Order.StopLimit, price=trigger_price, plimit=price)
            o["status"] = "trigger pending"
        bo = self.strategy.buy(**kwargs) if side == "BUY" else self.strategy.sell(**kwargs)
        self.bt_orders[oid] = bo
        self.by_ref[bo.ref] = oid
        return self._public(o)

    def _check(self, o: dict) -> str | None:
        sym, qty, typ, product = o["symbol"], o["quantity"], o["order_type"], o["product"]
        if sym in self.indices:
            return f"{sym} is an index and can't be traded"
        if typ not in ("MARKET", "LIMIT", "SL", "SL-M"):
            return f"Unknown order type {typ}; use MARKET, LIMIT, SL or SL-M"
        if product not in ("DELIVERY", "INTRADAY"):
            return f"Unknown product {product}; use DELIVERY or INTRADAY"
        if typ in ("LIMIT", "SL") and not (o["price"] and o["price"] > 0):
            return f"{typ} orders need a price"
        if typ in ("SL", "SL-M") and not (o["trigger_price"] and o["trigger_price"] > 0):
            return f"{typ} orders need a trigger_price"
        if o["_session"] is None:
            return "The backtest has reached its last candle; the order can't fill"
        if sym not in self.sim or self.sim[sym].empty:
            return f"No candles for {sym} in the backtest range"
        if product == "INTRADAY" and not o["_auto"]:
            if not self.intraday:
                return "INTRADAY orders need an intraday interval (1m-1h); on daily candles use DELIVERY"
            if o["_session"] in self.squared_sessions:
                return "INTRADAY positions are squared off at 15:15; no new INTRADAY orders today"
        ref_price = o["price"] if typ == "LIMIT" else (o["trigger_price"] if typ in ("SL", "SL-M") else self.last_close(sym))
        value = (ref_price or 0) * qty
        if o["_auto"]:
            return None
        if product == "DELIVERY" and o["side"] == "SELL":
            held = self.ledger.qty(sym, "DELIVERY")
            pending = sum(x["quantity"] for x in self.orders.values()
                          if x is not o and x["status"] in OPEN_STATES and x["symbol"] == sym and x["side"] == "SELL" and x["product"] == "DELIVERY")
            if qty > held - pending:
                return f"Not enough holdings to sell {qty} {sym} (holding {held}, {pending} already being sold); use INTRADAY to short"
        elif product == "DELIVERY":
            est = value + charges_mod.compute("BUY", "DELIVERY", ref_price or 0, qty, self.exchanges.get(sym, "NSE"), self.charge_cfg).total
            if est > self._available():
                return f"Insufficient cash: need about ₹{est:,.2f}, available ₹{self._available():,.2f}"
        else:
            closing = self.ledger.qty(sym, "INTRADAY")
            if not closing or (closing > 0) == (o["side"] == "BUY") or qty > abs(closing):
                need = value * self.margin
                if need > self._available():
                    return f"Insufficient margin: need ₹{need:,.2f} (20% of ₹{value:,.2f}), available ₹{self._available():,.2f}"
        return None

    @staticmethod
    def _public(o: dict) -> dict:
        return {k: v for k, v in o.items() if not k.startswith("_")}

    # --- Backtrader callbacks --------------------------------------------------------------------

    def on_bt_order(self, bo: bt.Order) -> None:
        oid = self.by_ref.get(bo.ref)
        if oid is None:
            return
        o = self.orders[oid]
        status = bo.getstatusname()
        if status in ("Submitted", "Accepted"):
            return
        if status == "Completed":
            qty = abs(int(bo.executed.size))
            price = float(bo.executed.price)
            when = bt.num2date(bo.executed.dt)
            sym = o["symbol"]
            ch = charges_mod.compute(o["side"], o["product"], price, qty, self.exchanges.get(sym, "NSE"), self.charge_cfg)
            self.total_charges += ch.total
            for k in ch.to_dict():
                if k != "total":
                    setattr(self.charge_totals, k, getattr(self.charge_totals, k) + getattr(ch, k))
            self.ledger.fill(sym, o["product"], o["side"], qty, price, ch.total, _iso(when))
            o.update(status="complete", filled_quantity=qty, average_price=round(price, 4))
            self.fill_count += 1
            if len(self.fills) < MAX_FILLS:
                self.fills.append({
                    "time": _iso(when), "order_id": oid, "symbol": sym, "side": o["side"], "product": o["product"],
                    "order_type": o["order_type"], "quantity": qty, "price": round(price, 4), "value": round(price * qty, 2),
                    "charges": round(ch.total, 2), "auto": o["_auto"], "placed": o["_placed"],
                })
        elif status == "Canceled":
            o["status"] = "cancelled"
            if not o["message"]:
                o["message"] = "Cancelled"
        elif status == "Expired":
            o.update(status="cancelled", message="Expired at the end of the trading day")
        else:  # Margin / Rejected
            o.update(status="rejected", message="Rejected by the simulator (insufficient cash at fill time)")
        if not o["_auto"]:
            self.r.on_order(Order.from_message(self._public(o)))

    def on_bar(self, new: list[str]) -> None:
        """One step of the timeline: the stocks in `new` just closed a candle."""
        ts = pd.Timestamp(self.strategy.datetime.datetime(0))
        self.now = ts
        for sym in new:
            pos = self.positions_in_full[sym].get(pd.Timestamp(self.strategy.getdatabyname(sym).datetime.datetime(0)))
            if pos is None:
                continue
            frame = self.aware[sym]
            self.r.indicators._frames[sym] = frame.iloc[max(0, pos + 1 - MAX_ROWS): pos + 1]
        if not self.r.started:
            self.r.start_hooks()
        for sym in new:
            row = self.r.indicators._frames[sym].iloc[-1]
            bar = {"time": pd.Timestamp(row.name).timestamp(), **{k: float(row[k]) for k in ("open", "high", "low", "close", "volume")}}
            self.r.candle(sym, Candle.from_message(sym, bar))

        if self._square_off_bar(ts):
            self._square_off(ts)
        if self._session_end(ts):
            self._expire(ts.date())
        if any(b.qty for b in self.ledger.books.values()):
            self.exposed_bars += 1
        self.equity.append((ts, self.equity_now()))

    def _square_off(self, ts: pd.Timestamp) -> None:
        session = ts.date()
        self.squared_sessions.add(session)
        nxt = self.next_ts.get(ts)
        if nxt is None or nxt.date() != session:
            self.warnings.append(f"{session}: no candle at 15:15, so INTRADAY positions were squared off at the next session's open")
        for oid, o in self.orders.items():
            if o["status"] in OPEN_STATES and o["product"] == "INTRADAY" and not o["_auto"]:
                o["message"] = "Cancelled by the 15:15 square-off"
                self.strategy.cancel(self.bt_orders[oid])
        for (sym, product), b in list(self.ledger.books.items()):
            if product == "INTRADAY" and b.qty:
                self.r.log("info", f"Auto square-off: {'SELL' if b.qty > 0 else 'BUY'} {abs(b.qty)} {sym} (INTRADAY) at 15:15")
                self._api_order("SELL" if b.qty > 0 else "BUY", abs(b.qty), sym, "MARKET", None, None, "INTRADAY", auto=True)

    def _expire(self, session) -> None:
        for oid, o in self.orders.items():
            if o["status"] in OPEN_STATES and o["_session"] == session:
                o["message"] = o["message"] or "Expired at the end of the trading day (DAY order)"
                self.strategy.cancel(self.bt_orders[oid])

    # --- results ---------------------------------------------------------------------------------

    def result(self, benchmark: pd.Series | None, elapsed: float) -> dict:
        eq = pd.Series([v for _, v in self.equity], index=pd.DatetimeIndex([t for t, _ in self.equity]), dtype=float)
        last_prices = {s: float(f["close"].iloc[-1]) for s, f in self.sim.items() if len(f)}
        end_iso = _iso(eq.index[-1]) if len(eq) else None
        open_trades = self.ledger.open_trades(last_prices, end_iso) if end_iso else []
        closed = self.ledger.trades
        final = float(eq.iloc[-1]) if len(eq) else self.capital

        summary = {
            "capital": self.capital, "final_value": round(final, 2),
            "net_pnl": round(final - self.capital, 2),
            "total_return_pct": round((final / self.capital - 1) * 100, 3),
            "candles": len(self.timeline), "orders": len(self.orders), "fills": self.fill_count,
            "total_charges": round(self.total_charges, 2),
            "charges_breakdown": self.charge_totals.to_dict(),
            "exposure_pct": round(self.exposed_bars / len(eq) * 100, 2) if len(eq) else 0.0,
            "elapsed_seconds": round(elapsed, 2),
        }
        summary.update(_return_stats(eq, self.capital))
        summary.update(trade_stats(closed))
        bench_curve = None
        if benchmark is not None and len(eq) and len(benchmark):
            b = benchmark.sort_index()
            aligned = b.reindex(b.index.union(eq.index)).ffill().reindex(eq.index)
            first = aligned.dropna()
            if len(first):
                bench_curve = aligned / first.iloc[0] * self.capital
                summary["benchmark_return_pct"] = round((first.iloc[-1] / first.iloc[0] - 1) * 100, 3)

        per_symbol = []
        for sym in self.universe:
            ts_ = [t for t in closed if t["symbol"] == sym]
            if ts_ or any(t["symbol"] == sym for t in open_trades):
                wins = sum(1 for t in ts_ if t["net_pnl"] > 0)
                per_symbol.append({
                    "symbol": sym, "trades": len(ts_), "net_pnl": round(sum(t["net_pnl"] for t in ts_), 2),
                    "win_rate_pct": round(wins / len(ts_) * 100, 2) if ts_ else None,
                    "open_pnl": round(sum(t["net_pnl"] for t in open_trades if t["symbol"] == sym), 2),
                })
        return {
            "summary": summary,
            "equity": _curve(eq, bench_curve, self.capital),
            "trades": closed + open_trades,
            "fills": self.fills,
            "fills_truncated": self.fill_count > len(self.fills),
            "per_symbol": per_symbol,
            "warnings": self.warnings[:20],
        }


def _return_stats(eq: pd.Series, capital: float) -> dict:
    if not len(eq):
        return {}
    daily = eq.groupby(eq.index.date).last()
    rets = pd.concat([pd.Series([daily.iloc[0] / capital - 1]), daily.pct_change().dropna()], ignore_index=True)
    days = max((eq.index[-1] - eq.index[0]).days, 1)
    out = {"cagr_pct": round(((eq.iloc[-1] / capital) ** (365.25 / days) - 1) * 100, 3) if eq.iloc[-1] > 0 and days >= 30 else None}
    std = rets.std(ddof=1) if len(rets) > 1 else 0.0
    out["sharpe"] = round(rets.mean() / std * math.sqrt(252), 3) if std and std > 0 else None
    downside = rets[rets < 0]
    dstd = math.sqrt((downside ** 2).sum() / len(rets)) if len(rets) else 0.0
    out["sortino"] = round(rets.mean() / dstd * math.sqrt(252), 3) if dstd > 0 else None
    dd = eq / eq.cummax().clip(lower=capital) - 1
    out["max_drawdown_pct"] = round(float(dd.min()) * 100, 3)
    longest, start = 0, None
    for t, v in dd.items():
        if v < 0 and start is None:
            start = t
        elif v >= 0 and start is not None:
            longest, start = max(longest, (t - start).days), None
    if start is not None:
        longest = max(longest, (eq.index[-1] - start).days)
    out["max_drawdown_days"] = longest
    return out


def _curve(eq: pd.Series, bench: pd.Series | None, capital: float) -> list[dict]:
    if not len(eq):
        return []
    dd = eq / eq.cummax().clip(lower=capital) - 1  # drawdown from the best value so far (or the starting capital)
    step = max(1, math.ceil(len(eq) / MAX_EQUITY_POINTS))
    idx = list(range(0, len(eq), step))
    if idx[-1] != len(eq) - 1:
        idx.append(len(eq) - 1)
    worst = int(dd.values.argmin())  # keep the deepest drawdown point visible
    if worst not in idx:
        idx = sorted(set(idx) | {worst})
    return [{
        "time": _iso(eq.index[i]), "equity": round(float(eq.iloc[i]), 2),
        "benchmark": round(float(bench.iloc[i]), 2) if bench is not None and pd.notna(bench.iloc[i]) else None,
        "drawdown_pct": round(float(dd.iloc[i]) * 100, 3),
    } for i in idx]


class _Strategy(bt.Strategy):
    params = (("sim", None),)

    def __init__(self) -> None:
        self.sim: Simulation = self.p.sim
        self.sim.strategy = self
        self._lens = {d._name: 0 for d in self.datas}
        self._progress = 0

    def notify_order(self, order) -> None:
        self.sim.on_bt_order(order)

    def prenext(self) -> None:
        self.next()  # stocks listed later than others must not hold the run back

    def next(self) -> None:
        new = []
        for sym in self.sim.universe:
            try:
                d = self.getdatabyname(sym)
            except KeyError:
                continue
            if len(d) > self._lens[sym]:
                self._lens[sym] = len(d)
                new.append(sym)
        if new:
            self.sim.on_bar(new)
            self._progress += 1
            self.sim.r.progress(self._progress, len(self.sim.timeline))


class BacktestRunner(Runner):
    """Loads the script like a live run, then replays history through it."""

    def __init__(self, script_path: str, stdin, stdout) -> None:
        super().__init__(script_path, stdin, stdout)
        self.started = False
        self._log_lines = 0
        self._last_progress = 0.0
        self.sim: Simulation | None = None

    def log(self, level: str, text: str) -> None:
        self._log_lines += 1
        if self._log_lines <= MAX_LOG_LINES:
            self.send({"type": "log", "level": level, "text": text, "time": _iso(self.sim.now) if self.sim and self.sim.now is not None else None})
        elif self._log_lines == MAX_LOG_LINES + 1:
            self.send({"type": "log", "level": "warning", "text": f"More than {MAX_LOG_LINES:,} log lines; the rest are not shown"})

    def progress(self, done: int, total: int) -> None:
        now = time.monotonic()
        if now - self._last_progress > 0.25 or done == total:
            self._last_progress = now
            self.send({"type": "progress", "done": done, "total": total})

    def start_hooks(self) -> None:
        self.started = True
        self.hook("on_start", self.api)

    def candle(self, sym: str, c: Candle) -> None:
        self._current = sym
        self.hook("on_candle", c, self.indicators, self.api)

    def on_order(self, order: Order) -> None:
        if order.symbol in self.universe:
            self._current = order.symbol
        self.hook("on_order", order, self.api)

    def run(self) -> int:
        if not self.load():
            return 1
        cfg = self._read()
        if not cfg or cfg.get("type") != "init":
            return 1
        t0 = time.monotonic()
        self.universe = [s.upper() for s in cfg["symbols"]]
        cfg["symbols"] = self.universe
        self._current = self.universe[0]
        frames = {}
        for sym, path in cfg["data"].items():
            df = pd.read_parquet(path)
            df.index = pd.DatetimeIndex(df.index).tz_convert(IST).tz_localize(None)
            frames[sym.upper()] = df[["open", "high", "low", "close", "volume"]].astype(float).sort_index()
        self.indicators = Indicators(self.universe, lambda: self._current)
        self.sim = sim = Simulation(self, cfg, frames)
        self.api = Api(sim.call, self.log, self.universe, lambda: self._current, self.indicators.df, "backtest")
        if not len(sim.timeline):
            self.send({"type": "fatal", "text": "No candles in the chosen date range"})
            return 1
        self.send({"type": "ready"})

        cerebro = bt.Cerebro(stdstats=False, runonce=False, preload=True, quicknotify=True)
        for sym in self.universe:
            f = sim.sim.get(sym)
            if f is not None and len(f):
                cerebro.adddata(bt.feeds.PandasData(dataname=f, name=sym))
        cerebro.broker.setcash(sim.capital + CASH_OFFSET)
        cerebro.broker.set_checksubmit(False)  # cash/margin rules are checked by Simulation
        slip = float(cfg.get("slippage_pct") or 0) / 100
        if slip > 0:
            cerebro.broker.set_slippage_perc(slip, slip_open=True, slip_limit=True, slip_match=True, slip_out=False)
        cerebro.addstrategy(_Strategy, sim=sim)
        try:
            cerebro.run()
        except SystemExit as e:  # the runner already reported a fatal error
            return int(e.code or 1)
        finally:
            if self.started:
                try:
                    self.hook("on_stop", self.api)
                except SystemExit:
                    pass

        bench = None
        if cfg.get("benchmark"):
            b = pd.read_parquet(cfg["benchmark"])
            b.index = pd.DatetimeIndex(b.index).tz_convert(IST).tz_localize(None)
            bench = b["close"].astype(float)
        self.send({"type": "result", "result": sim.result(bench, time.monotonic() - t0)})
        return 0


def main() -> int:
    protocol_out = sys.stdout
    runner = BacktestRunner(sys.argv[1], sys.stdin, protocol_out)
    sys.stdout = _LogStream(runner.log, "info")
    sys.stderr = _LogStream(runner.log, "error")
    try:
        return runner.run()
    finally:
        sys.stdout.flush()
        sys.stderr.flush()


if __name__ == "__main__":
    sys.exit(main())

