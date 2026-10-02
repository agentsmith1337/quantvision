"""Generate the indicator catalog (and the API docs table) from pandas-ta-classic + TA-Lib.

    python sdk/tools/build_indicators.py           # regenerate + verify every shortcut
    python sdk/tools/build_indicators.py --check   # fail if the committed catalog is stale

Writes:
  sdk/quantvision/indicator_catalog.json   used by the SDK (methods), the editor (autocomplete)
  sdk/sdk_reference.md                     the section between the indicators markers

Each catalog entry describes one `indicators.<name>(...)` shortcut: the pandas-ta function
it wraps, its inputs, parameters (pandas-ta's `length` is exposed as `period`) with
defaults, and what it returns (a number, named fields, or a table).
"""

import argparse
import ast
import importlib
import inspect
import json
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import pandas as pd
import pandas_ta_classic as ta

warnings.filterwarnings("ignore")

SDK = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SDK))
CATALOG = SDK / "quantvision" / "indicator_catalog.json"
REFERENCE = SDK / "sdk_reference.md"
START, END = "<!-- indicators:start -->", "<!-- indicators:end -->"

SERIES_INPUTS = ("open_", "high", "low", "close", "volume")
# Parameters never exposed: implementation details or look-ahead risks (offset shifts data).
HIDDEN = {"offset", "talib", "kwargs", "as_dataframe", "append_span", "mode_talib"}
# Not indicators (they combine arbitrary series); reachable via indicators.df().ta.
# `ma` is a dispatcher over the moving averages, which all have their own shortcuts.
SKIPPED = {"long_run", "short_run", "xsignals", "tsignals", "mavp", "cdl_pattern", "ma"}
# Two-series statistics: this stock against another stock in the run.
PAIRS = {"beta", "correl"}

# QuantVision defaults that differ from pandas-ta's (kept from the original SDK / standard usage).
DEFAULT_OVERRIDES = {
    "sma": {"length": 20}, "ema": {"length": 20}, "wma": {"length": 20},
    "bbands": {"length": 20},
    "vwap": {"anchor": "D"},
}
# Defaults the source parser can't read (set indirectly in pandas-ta), checked by hand.
MANUAL_DEFAULTS = {
    "inertia": {"refined": False, "thirds": False},
    "rvi": {"refined": False, "thirds": False},
    "slope": {"as_angle": False, "to_degrees": False, "vertical": False},
    "squeeze": {"tr": True}, "squeeze_pro": {"tr": True},
    "jma": {"length": 7},
    "adxr": {"scalar": 100, "mamode": "rma"},
    "cksp": {"x": 3, "q": 20},
    "psar": {"af0": 0.02},
    "sarext": {f"acceleration{k}{side}": v for side in ("long", "short") for k, v in (("init", 0.02), ("", 0.02), ("max", 0.2))},
    "ce": {"mamode": "rma"},
}
# Parameters pandas-ta reads under a different name (its `use_tr` argument is ignored in favour of `tr`).
ARG_NAMES = {("squeeze", "use_tr"): "tr", ("squeeze_pro", "use_tr"): "tr"}
# Parameters whose default is another parameter's value.
SAME_AS = {"adx": {"lensig": "period"}, "adxr": {"lensig": "period"}, "psar": {"af0": "af"}}

# Always passed, never exposed: removes look-ahead bias.
FIXED = {"dpo": {"centered": False}, "ichimoku": {"as_dataframe": True}}  # ichimoku: no forward span rows

NOTES = {
    "ichimoku": "chikou is the close shifted 26 candles back, so its latest value is always None in live trading; the forward cloud isn't returned.",
    "dpo": "Computed non-centred (no look-ahead).",
    "vp": "Returns a table (pandas.DataFrame) of price ranges for the whole history, not a per-candle value.",
    "tos_stdevall": "Regression over all available history.",
    "vwap": "Resets each trading day (anchor='D').",
    "cpr": "width_class and position are text labels.",
}

# Friendly field names for multi-value indicators, in pandas-ta's column order.
FIELDS = {
    "aberration": ["middle", "upper", "lower", "atr"],
    "accbands": ["lower", "middle", "upper"],
    "adx": ["adx", "plus_di", "minus_di"],
    "adxr": ["adxr", "plus_di", "minus_di"],
    "amat": ["long_run", "short_run"],
    "aobv": ["obv", "obv_min", "obv_max", "obv_fast", "obv_slow", "long_run", "short_run"],
    "aroon": ["down", "up", "oscillator"],
    "bbands": ["lower", "middle", "upper", "bandwidth", "percent"],
    "brar": ["ar", "br"],
    "cdl_z": ["open", "high", "low", "close"],
    "ce": ["long_stop", "short_stop"],
    "cksp": ["long_stop", "short_stop"],
    "cpr": ["tc", "pivot", "bc", "r1", "r2", "s1", "s2", "width", "width_pct", "width_class", "position"],
    "dm": ["plus_dm", "minus_dm"],
    "donchian": ["lower", "middle", "upper"],
    "drawdown": ["drawdown", "percent", "log"],
    "eri": ["bull_power", "bear_power"],
    "fisher": ["fisher", "signal"],
    "ha": ["open", "high", "low", "close"],
    "hilo": ["hilo", "long", "short"],
    "ht_phasor": ["inphase", "quadrature"],
    "ht_sine": ["sine", "lead_sine"],
    "hwc": ["middle", "upper", "lower"],
    "ichimoku": ["span_a", "span_b", "tenkan", "kijun", "chikou"],
    "kc": ["lower", "basis", "upper"],
    "kdj": ["k", "d", "j"],
    "kst": ["kst", "signal"],
    "kvo": ["kvo", "signal"],
    "macd": ["macd", "histogram", "signal"],
    "macdext": ["macd", "signal", "histogram"],
    "macdfix": ["macd", "histogram", "signal"],
    "mama": ["mama", "fama"],
    "mmar": ["ma1", "ma2", "ma3", "ma4", "ma5", "ma6"],
    "msw": ["sine", "lead"],
    "ppo": ["ppo", "histogram", "signal"],
    "psar": ["long", "short", "af", "reversal"],
    "pvo": ["pvo", "histogram", "signal"],
    "qqe": ["qqe", "rsi_ma", "long", "short", "long_band", "short_band", "direction"],
    "rainbow": [f"ma{i}" for i in range(1, 11)],
    "rvgi": ["histogram", "rvgi", "signal"],
    "smi": ["smi", "signal", "oscillator"],
    "squeeze": ["sqz", "on", "off", "no_squeeze"],
    "squeeze_pro": ["sqz", "on_wide", "on_normal", "on_narrow", "off", "no_squeeze"],
    "stc": ["stc", "macd", "stoch"],
    "stoch": ["k", "d"],
    "stochf": ["k", "d"],
    "stochrsi": ["k", "d"],
    "supertrend": ["value", "direction", "long", "short"],
    "td_seq": ["up", "down"],
    "thermo": ["thermo", "ma", "long", "short"],
    "tos_stdevall": ["lr", "lower_1", "upper_1", "lower_2", "upper_2", "lower_3", "upper_3"],
    "trix": ["trix", "signal"],
    "trixh": ["trix", "signal", "histogram"],
    "tsi": ["tsi", "signal"],
    "vortex": ["plus", "minus"],
    "vwmacd": ["macd", "histogram", "signal"],
}
TABLES = {"vp"}
# Tuple order where it differs from the column order (kept from the original SDK).
TUPLE_ORDER = {
    "macd": ["macd", "signal", "histogram"],
    "bbands": ["upper", "middle", "lower", "bandwidth", "percent"],
}


def _returns(name: str) -> dict:
    if name in TABLES:
        return {"kind": "table"}
    if name not in FIELDS:
        return {"kind": "value"}
    columns = FIELDS[name]
    fields = TUPLE_ORDER.get(name, columns)
    return {"kind": "fields", "fields": fields, "columns": [columns.index(f) for f in fields]}

_ELSE = re.compile(r"^\s*(\w+)\s*=\s*.*?\belse\s+(.+?)\s*(?:#.*)?$", re.M)
_HELPER = re.compile(r"^\s*(\w+)\s*=\s*[\w.]+\(\s*\1\s*,\s*([^,()]+?)\s*\)", re.M)  # x = _pos_int(x, 12)


def _literal(text: str):
    try:
        return ast.literal_eval(text)
    except (ValueError, SyntaxError):
        return None


def _defaults(fn) -> dict:
    """Parameter defaults as pandas-ta applies them (it uses None in signatures)."""
    out = {}
    for name, p in inspect.signature(fn).parameters.items():
        if p.default not in (inspect.Parameter.empty, None):
            out[name] = p.default
    try:
        src = inspect.getsource(fn)
    except (OSError, TypeError):
        return out
    for rx in (_ELSE, _HELPER):
        for m in rx.finditer(src):
            value = _literal(m.group(2))
            if value is not None and m.group(1) not in out:
                out[m.group(1)] = value
    if "drift" in inspect.signature(fn).parameters:
        out.setdefault("drift", 1)
    return out


def _title(fn) -> str:
    doc = (fn.__doc__ or "").strip().splitlines()
    return doc[0].strip().rstrip(".") if doc else fn.__name__


def _category_of() -> dict[str, str]:
    return {name: cat for cat, names in ta.Category.items() for name in names}


def sample_frame(n: int = 400) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    close = 1000 + np.cumsum(rng.normal(0, 4, n))
    idx = pd.date_range("2026-01-05 09:15", periods=n, freq="5min", tz="Asia/Kolkata")
    open_ = close + rng.normal(0, 1.5, n)
    return pd.DataFrame({
        "open": open_, "high": np.maximum(open_, close) + rng.uniform(0, 3, n),
        "low": np.minimum(open_, close) - rng.uniform(0, 3, n), "close": close,
        "volume": rng.integers(1_000, 50_000, n).astype(float),
    }, index=idx)


def build() -> list[dict]:
    categories = _category_of()
    entries = []
    for name in sorted(categories):
        fn = getattr(ta, name, None)
        if fn is None or name in SKIPPED:
            continue
        sig = inspect.signature(fn).parameters
        inputs = [p.rstrip("_") for p in sig if p in SERIES_INPUTS]
        overrides = DEFAULT_OVERRIDES.get(name, {})
        defaults = {**_defaults(fn), **MANUAL_DEFAULTS.get(name, {}), **overrides}
        fixed = dict(FIXED.get(name, {}))
        if "talib" in sig:
            fixed["talib"] = False  # pandas-ta's own Python implementation, consistently
        params = []
        for p in sig:
            if p in SERIES_INPUTS or p in HIDDEN or p in fixed or (name in PAIRS and p == "benchmark"):
                continue
            arg = ARG_NAMES.get((name, p), p)
            param = {"name": "period" if p == "length" else p, "arg": arg, "default": defaults.get(arg)}
            if p in SAME_AS.get(name, {}):
                param["same_as"] = SAME_AS[name][p]
                param["default"] = None
            params.append(param)
        entry = {
            "name": name, "function": name, "category": categories[name], "title": _title(fn),
            "inputs": inputs, "params": params, "fixed": fixed, "overrides": overrides,
            "returns": _returns(name),
        }
        if name in PAIRS:
            entry["pair"] = True
            entry["params"].insert(0, {"name": "other", "arg": "benchmark", "default": None})
        if name in NOTES:
            entry["notes"] = NOTES[name]
        entries.append(entry)

    # TA-Lib candlestick patterns, one shortcut each.
    patterns = importlib.import_module("pandas_ta_classic.candles.cdl_pattern")
    talib = importlib.import_module("talib")
    native = {"doji", "inside"}  # pandas-ta has its own cdl_doji / cdl_inside
    for pattern in patterns.ALL_PATTERNS:
        if pattern in native:
            continue
        doc = getattr(talib, "CDL" + pattern.upper()).__doc__ or ""
        title = next((line.replace("(Pattern Recognition)", "").strip() for line in doc.splitlines() if "(Pattern Recognition)" in line), pattern)
        params = [{"name": m.group(1), "arg": m.group(1), "default": _literal(m.group(2))}
                  for m in re.finditer(r"^\s{4}(\w+): ([\d.]+)$", doc.split("Parameters:", 1)[1].split("Outputs:")[0], re.M)] if "Parameters:" in doc else []
        entries.append({
            "name": f"cdl_{pattern}", "function": "cdl_pattern", "category": "candles",
            "title": f"{title} candlestick pattern",
            "inputs": ["open", "high", "low", "close"],
            "params": params, "fixed": {"name": pattern}, "overrides": {},
            "returns": {"kind": "pattern"},
        })
    return sorted(entries, key=lambda e: (e["category"], e["name"]))


def verify(entries: list[dict]) -> list[str]:
    """Run every shortcut through the real SDK on sample data."""
    from quantvision.indicators import Indicators

    df = sample_frame()
    bars = [{"time": int(ts.timestamp()), **{k: float(v) for k, v in row.items()}} for ts, row in df.iterrows()]
    ind = Indicators(["TEST", "OTHER"], lambda: "TEST", catalog=entries)
    ind.load("TEST", bars)
    ind.load("OTHER", [{**b, "close": b["close"] * 1.01 + 3} for b in bars])
    problems = []
    for e in entries:
        kwargs = {"other": "OTHER"} if e.get("pair") else {}
        try:
            if any(p["name"] == "penetration" for p in e["params"]):
                getattr(ind, e["name"])(penetration=0.5)  # forwarded to TA-Lib
            value = getattr(ind, e["name"])(**kwargs)
        except Exception as ex:
            problems.append(f"{e['name']}: {type(ex).__name__}: {ex}")
            continue
        kind = e["returns"]["kind"]
        if kind == "fields" and tuple(value._fields) != tuple(e["returns"]["fields"]):
            problems.append(f"{e['name']}: columns {list(ind.series(e['name'], **kwargs).columns)} don't match {e['returns']['fields']}")
        elif kind in ("value", "pattern") and value is not None and not isinstance(value, (int, float, str)):
            problems.append(f"{e['name']}: returned {type(value).__name__}")
        elif kind == "table" and not isinstance(value, pd.DataFrame):
            problems.append(f"{e['name']}: expected a table")
    return problems


# --- docs ------------------------------------------------------------------------------------

CATEGORY_TITLES = {
    "candles": "Candlestick patterns", "cycles": "Cycles", "momentum": "Momentum", "overlap": "Moving averages & overlays",
    "performance": "Performance", "statistics": "Statistics", "trend": "Trend", "volatility": "Volatility", "volume": "Volume",
}


def _fmt_default(v) -> str:
    return repr(v) if v is not None else "None"


def signature(e: dict) -> str:
    args = [f"{p['name']}={_fmt_default(p['default'])}" for p in e["params"]]
    return f"{e['name']}({', '.join(args + ['symbol=None'])})"


def returns_text(e: dict) -> str:
    kind = e["returns"]["kind"]
    if kind == "fields":
        return ", ".join(f"`.{f}`" for f in e["returns"]["fields"])
    if kind == "pattern":
        return "100 bullish, -100 bearish, 0 none"
    if kind == "table":
        return "DataFrame"
    return "number"


def docs(entries: list[dict]) -> str:
    patterns = sum(1 for e in entries if e["returns"]["kind"] == "pattern" or e["name"] in ("cdl_doji", "cdl_inside"))
    lines = [
        START,
        "## Indicator reference",
        "",
        f"{len(entries)} shortcuts: {len(entries) - patterns} indicators and {patterns} candlestick patterns, all called as "
        "`indicators.<name>(...)`. Each returns the latest closed candle's value (`None` without enough history), "
        "takes `symbol=`, and has a full-history twin `indicators.series(\"<name>\", ...)`. "
        "Generated from `indicator_catalog.json`, which the editor's autocomplete also uses.",
        "",
    ]
    by_cat: dict[str, list[dict]] = {}
    for e in entries:
        by_cat.setdefault(e["category"], []).append(e)
    for cat in sorted(by_cat, key=lambda c: list(CATEGORY_TITLES).index(c) if c in CATEGORY_TITLES else 99):
        items = by_cat[cat]
        lines += [f"### {CATEGORY_TITLES.get(cat, cat.title())} ({len(items)})", ""]
        if cat == "candles":
            lines += ["Candlestick patterns return 100 (bullish), -100 (bearish) or 0 (no pattern) for the latest candle; most take no parameters.", ""]
        lines += ["| Shortcut | Returns | What it is |", "|---|---|---|"]
        for e in items:
            note = f" *{e['notes']}*" if e.get("notes") else ""
            note += "".join(f" `{p['name']}` defaults to `{p['same_as']}`." for p in e["params"] if p.get("same_as"))
            pair = " Compares this stock with `other`." if e.get("pair") else ""
            lines.append(f"| `{signature(e)}` | {returns_text(e)} | {e['title']}.{pair}{note} |")
        lines.append("")
    lines.append(END)
    return "\n".join(lines)


def write_docs(entries: list[dict]) -> None:
    text = REFERENCE.read_text(encoding="utf-8")
    section = docs(entries)
    if START in text:
        before, rest = text.split(START, 1)
        after = rest.split(END, 1)[1]
        text = before + section + after
    else:
        text = text.rstrip() + "\n\n" + section + "\n"
    REFERENCE.write_text(text, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail if the committed catalog differs")
    args = parser.parse_args()
    entries = build()
    rendered = json.dumps(entries, indent=1, ensure_ascii=False) + "\n"
    if args.check:
        current = CATALOG.read_text(encoding="utf-8") if CATALOG.exists() else ""
        if current != rendered:
            print("indicator_catalog.json is stale; run sdk/tools/build_indicators.py")
            return 1
        return 0
    problems = verify(entries)
    if problems:
        print("Shortcuts that failed on sample data:")
        print("\n".join(f"  {p}" for p in problems))
        return 1
    CATALOG.write_text(rendered, encoding="utf-8")
    write_docs(entries)
    counts = {}
    for e in entries:
        counts[e["returns"]["kind"]] = counts.get(e["returns"]["kind"], 0) + 1
    print(f"{len(entries)} shortcuts verified and written ({counts})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
