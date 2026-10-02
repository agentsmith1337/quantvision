"""Symbol search and resolution from Angel One's daily scrip master."""

import json
from datetime import datetime, timedelta

from app.market.instruments import parse_key, registry, symbol_key
from app.market.scripmaster import CACHE_VERSION, IST, ScripMaster, filter_rows, parse_nse_companies
from tests.conftest import SCRIP_ROWS, signin


def test_filter_keeps_cash_equities_and_indices_only():
    raw = [
        {"exch_seg": "NSE", "instrumenttype": "", "symbol": "SBIN-EQ", "token": "3045", "name": "SBIN"},
        {"exch_seg": "NSE", "instrumenttype": "", "symbol": "SBIN-BE", "token": "9", "name": "SBIN"},  # block segment
        {"exch_seg": "BSE", "instrumenttype": "", "symbol": "SBIN", "token": "500112", "name": "SBIN"},
        {"exch_seg": "NSE", "instrumenttype": "AMXIDX", "symbol": "Nifty Bank", "token": "99926009", "name": "BANKNIFTY"},
        {"exch_seg": "NFO", "instrumenttype": "OPTSTK", "symbol": "SBIN26OCT800CE", "token": "1", "name": "SBIN"},
        {"exch_seg": "MCX", "instrumenttype": "FUTCOM", "symbol": "GOLD", "token": "2", "name": "GOLD"},
    ]
    kept = filter_rows(raw, {"SBIN": "State Bank of India"})
    assert [(r.exchange, r.trading_symbol, r.is_index, r.display_name) for r in kept] == [
        ("NSE", "SBIN-EQ", False, "State Bank of India"),
        ("BSE", "SBIN", False, "State Bank of India"),  # BSE takes the NSE company's name
        ("NSE", "Nifty Bank", True, "Nifty Bank"),
    ]


def test_nse_company_list_parsing():
    text = (
        "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING\n"
        "M&M,Mahindra & Mahindra Limited,EQ,01-JAN-2000\n"
        "ETERNAL,ETERNAL LIMITED,EQ,23-JUL-2021\n"
        "ABC,Abc Ltd.,EQ,01-JAN-2010\n"
    )
    assert parse_nse_companies(text) == {"M&M": "Mahindra & Mahindra", "ETERNAL": "ETERNAL", "ABC": "Abc"}


def test_search_by_company_name():
    sm = ScripMaster()
    sm.set_rows(SCRIP_ROWS, "2026-01-01")
    assert sm.search("state bank")[0].trading_symbol == "SBIN-EQ"
    assert sm.search("mahindra")[0].trading_symbol == "M&M-EQ"
    assert [r.trading_symbol for r in sm.search("bank")] == ["SBIN-EQ", "HDFCBANK-EQ"]  # word prefix
    assert sm.search("  tata   power ")[0].trading_symbol == "TATAPOWER-EQ"
    assert sm.search("utique")[0].display_name == "UTIQUE"  # BSE-only listings stay ticker-only


def test_search_ranks_exact_then_prefix_then_substring():
    sm = ScripMaster()
    sm.set_rows(SCRIP_ROWS, "2026-01-01")
    assert [r.trading_symbol for r in sm.search("HDFC")] == ["HDFCAMC-EQ", "HDFCBANK-EQ"]
    # Exact matches first; NSE before BSE for the same name.
    assert [(r.exchange, r.trading_symbol) for r in sm.search("reliance")] == [("NSE", "RELIANCE-EQ"), ("BSE", "RELIANCE")]
    assert sm.search("NIFTY")[0].trading_symbol == "Nifty 50"  # index name match
    assert [r.trading_symbol for r in sm.search("STEEL")] == ["TATASTEEL-EQ"]  # substring
    assert sm.search("ZZQXV") == []


def test_symbol_keys_round_trip():
    assert symbol_key("NSE", "RELIANCE-EQ") == "RELIANCE"
    assert symbol_key("BSE", "RELIANCE") == "BSE:RELIANCE"
    assert symbol_key("NSE", "Nifty IT") == "NSE:NIFTY IT"
    for key in ("RELIANCE", "BSE:RELIANCE", "NSE:NIFTY IT", "M&M"):
        exchange, ts = parse_key(key)
        assert symbol_key(exchange, ts) == key


def test_registry_resolves_unseen_symbols_from_the_scrip_master(client):
    inst = registry.get("TATAPOWER")
    assert inst is not None and inst.token == "3426" and inst.exchange == "NSE"
    idx = registry.get("NSE:NIFTY IT")
    assert idx is not None and idx.is_index and idx.token == "99926008"
    # The built-in index keeps its short key even when the scrip master names it differently.
    nifty_row = next(r for r in SCRIP_ROWS if r.trading_symbol == "Nifty 50")
    assert registry.from_scrip(nifty_row).symbol == "NIFTY"
    assert registry.get("NOPE-NOT-LISTED") is None


def test_old_format_cache_serves_searches_but_is_replaced_today(tmp_path, monkeypatch):
    path = tmp_path / "scripmaster.json"
    today = datetime.now(IST).date().isoformat()
    # Version-1 cache: no company names, no version field.
    path.write_text(json.dumps({"date": today, "rows": [[r.exchange, r.trading_symbol, r.token, r.name, r.is_index] for r in SCRIP_ROWS]}), encoding="utf-8")
    refreshed = []
    monkeypatch.setattr(ScripMaster, "_refresh", lambda self, p: refreshed.append(p))
    sm = ScripMaster()
    sm.ensure_fresh(path, background=False)
    assert sm.loaded and sm.search("SBIN")
    assert refreshed == [path]


def test_stale_cache_is_used_while_fresh_copy_is_due(tmp_path, monkeypatch):
    path = tmp_path / "scripmaster.json"
    yesterday = (datetime.now(IST) - timedelta(days=2)).date().isoformat()
    path.write_text(json.dumps({"version": CACHE_VERSION, "date": yesterday, "rows": [list(r.__dict__.values()) for r in SCRIP_ROWS]}), encoding="utf-8")
    refreshed = []
    monkeypatch.setattr(ScripMaster, "_refresh", lambda self, p: refreshed.append(p))
    sm = ScripMaster()
    sm.ensure_fresh(path, background=False)
    assert sm.loaded and sm.date == yesterday  # old copy serves searches meanwhile
    assert refreshed == [path]  # and a download was started


def test_search_endpoint_uses_the_local_file(client):
    # Engine runs on the simulated feed in tests (no Angel One session), so these
    # results can only have come from the scrip master.
    signin(client)
    results = client.get("/api/market/search", params={"q": "tata"}).json()
    assert {r["symbol"] for r in results} >= {"TATASTEEL", "TATAPOWER"}
    by_name = client.get("/api/market/search", params={"q": "state bank"}).json()
    assert by_name[0]["symbol"] == "SBIN" and by_name[0]["name"] == "State Bank of India"
    assert client.get("/api/market/instruments/TATASTEEL").json()["token"] == "3499"


def test_previously_registered_tickers_get_company_names(client):
    registry.register("NSE", "SBIN-EQ", "3045", "SBIN")  # as registered before names existed
    registry.apply_company_names(SCRIP_ROWS)
    assert registry.get("SBIN").name == "State Bank of India"
    assert registry.get("RELIANCE").name == "Reliance Industries"  # built-in keeps its own name
