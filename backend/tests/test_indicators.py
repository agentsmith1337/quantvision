"""The catalog-driven indicator shortcuts (run in the backend venv, which has pandas-ta-classic + TA-Lib)."""

import inspect
import json
import subprocess
import sys
from pathlib import Path

import pandas as pd
import pandas_ta_classic as ta
import pytest

SDK = Path(__file__).resolve().parents[1] / "sdk"
sys.path.insert(0, str(SDK))
sys.path.insert(0, str(SDK / "tools"))

from build_indicators import sample_frame  # noqa: E402
from quantvision.indicators import Indicators, load_catalog  # noqa: E402

CATALOG = load_catalog()


@pytest.fixture(scope="module")
def ind() -> Indicators:
    df = sample_frame()
    bars = [{"time": int(ts.timestamp()), **{k: float(v) for k, v in row.items()}} for ts, row in df.iterrows()]
    current = {"symbol": "TEST"}
    i = Indicators(["TEST", "OTHER"], lambda: current["symbol"])
    i.load("TEST", bars)
    i.load("OTHER", [{**b, "close": b["close"] * 1.01 + 3} for b in bars])
    return i


def test_catalog_covers_pandas_ta_and_candles():
    names = {e["name"] for e in CATALOG}
    skipped = {"long_run", "short_run", "xsignals", "tsignals", "mavp", "cdl_pattern", "ma"}
    library = {n for names_ in ta.Category.values() for n in names_} - skipped
    assert library <= names
    patterns = [e for e in CATALOG if e["returns"]["kind"] == "pattern"]
    assert len(patterns) + 2 == 62  # TA-Lib patterns + pandas-ta's cdl_doji/cdl_inside
    assert {"cdl_engulfing", "cdl_hammer", "cdl_doji", "cdl_inside"} <= names


def test_catalog_is_up_to_date():
    result = subprocess.run([sys.executable, str(SDK / "tools" / "build_indicators.py"), "--check"], capture_output=True, text=True)
    assert result.returncode == 0, result.stdout + result.stderr


def test_every_shortcut_is_a_method_with_its_signature():
    for e in CATALOG:
        method = getattr(Indicators, e["name"])
        params = inspect.signature(method).parameters
        assert list(params)[1:] == [p["name"] for p in e["params"]] + ["symbol"], e["name"]
        assert params["symbol"].kind is inspect.Parameter.KEYWORD_ONLY
        assert method.__doc__


def test_values_match_pandas_ta(ind):
    df = ind.df()
    assert ind.rsi() == pytest.approx(ta.rsi(df["close"]).iloc[-1])
    assert ind.rsi(period=7) == pytest.approx(ta.rsi(df["close"], length=7).iloc[-1])
    assert ind.rsi(length=7) == ind.rsi(period=7)
    assert ind.rsi(7) == ind.rsi(period=7)  # positional
    assert ind.sma() == pytest.approx(df["close"].tail(20).mean())  # QuantVision default period 20
    assert ind.cci(period=20) == pytest.approx(ta.cci(df["high"], df["low"], df["close"], length=20).iloc[-1])


def test_multi_value_fields_and_backward_compatible_order(ind):
    m = ind.macd()
    assert m._fields == ("macd", "signal", "histogram")
    assert m.histogram == pytest.approx(m.macd - m.signal)
    bb = ind.bbands()
    assert bb._fields[:3] == ("upper", "middle", "lower") and bb.lower < bb.middle < bb.upper
    assert ind.bbands().middle == pytest.approx(ind.sma(period=20))  # period 20 by default
    st = ind.supertrend()
    assert st.direction in (1, -1) and isinstance(st.direction, int)
    assert ind.adx()._fields == ("adx", "plus_di", "minus_di")
    assert ind.stoch()._fields == ("k", "d")
    assert ind.ichimoku().chikou is None  # documented: no look-ahead


def test_candlestick_patterns(ind):
    for name in ("cdl_engulfing", "cdl_hammer", "cdl_doji", "cdl_morningstar"):
        assert getattr(ind, name)() in (-100, 0, 100)
    assert ind.cdl_morningstar(penetration=0.5) in (-100, 0, 100)
    history = ind.series("cdl_engulfing")
    assert isinstance(history, pd.Series) and set(history.dropna().unique()) <= {-100, 0, 100}


def test_symbols_pairs_and_tables(ind):
    assert ind.rsi(symbol="OTHER") != ind.rsi()
    with pytest.raises(ValueError, match="isn't in this run"):
        ind.rsi(symbol="INFY")
    assert ind.beta(other="OTHER") == pytest.approx(1.01, abs=0.05)
    with pytest.raises(ValueError, match="other="):
        ind.correl()
    assert isinstance(ind.vp(), pd.DataFrame)
    with pytest.raises(TypeError):
        ind.rsi(bogus=1)


def test_series_and_crossovers(ind):
    ema = ind.series("ema", period=9)
    assert isinstance(ema, pd.Series) and ema.iloc[-1] == pytest.approx(ind.ema(period=9))
    macd = ind.series("macd")
    assert list(macd.columns) == ["macd", "signal", "histogram"]
    with pytest.raises(AttributeError, match="available"):
        ind.series("nope")

    s = pd.Series([1.0, 2.0, 3.0, 5.0])
    t = pd.Series([2.0, 2.5, 3.5, 4.0])
    assert Indicators.crossed_above(s, t) and not Indicators.crossed_below(s, t)
    assert Indicators.crossed_below(t, s)
    assert ind.crossed_above(s, 4) and not ind.crossed_above(s, 2)
    assert ind.crossed_below(4, s)
    assert not ind.crossed_above(pd.Series([1.0]), 0)
    with pytest.raises(TypeError):
        ind.crossed_above(1, 2)


def test_empty_history_returns_none():
    i = Indicators(["X"], lambda: "X")
    assert i.rsi() is None
    assert i.macd() == (None, None, None)
    assert i.cdl_engulfing() is None
    assert i.series("ema").empty


def test_indicators_endpoint(client):
    from conftest import signin

    signin(client)
    r = client.get("/api/scripts/indicators")
    assert r.status_code == 200
    entries = {e["name"]: e for e in r.json()}
    assert len(entries) == len(CATALOG)
    assert entries["macd"]["returns"]["fields"] == ["macd", "signal", "histogram"]
    assert "arg" not in entries["rsi"]["params"][0]
    assert json.dumps(entries)  # serialisable
