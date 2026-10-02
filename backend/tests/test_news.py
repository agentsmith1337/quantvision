"""GNews integration, with the HTTP call faked (no real requests, no quota used)."""

import io
import json
import sqlite3
import urllib.error
from pathlib import Path

import pytest

from app import news as news_module
from app.market.instruments import Instrument, registry
from app.news import build_query, news
from tests.conftest import signin

KEY = "gnews-test-key-123456"


class FakeGNews:
    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.fail: urllib.error.HTTPError | None = None

    def __call__(self, params: dict) -> dict:
        self.calls.append(params)
        if self.fail:
            raise self.fail
        return {"totalArticles": 2, "articles": [
            {"title": f"News about {params['q']}", "description": "d", "url": "https://example.com/a", "image": None,
             "publishedAt": "2026-10-02T09:00:00Z", "source": {"name": "Example Times"}},
            {"title": "unsafe link", "url": "javascript:alert(1)", "publishedAt": "2026-10-02T08:00:00Z", "source": {}},
        ]}


def http_error(code: int, message: str) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://gnews.io", code, "err", {}, io.BytesIO(json.dumps({"errors": [message]}).encode()))


@pytest.fixture
def gnews(monkeypatch):
    fake = FakeGNews()
    monkeypatch.setattr(news_module, "_fetch", fake)
    news._cache.clear()
    return fake


def test_query_combines_company_name_and_symbol():
    assert build_query(Instrument("RELIANCE", "Reliance Industries", "NSE", "2885", "RELIANCE-EQ")) == '"Reliance Industries" OR "RELIANCE"'
    assert build_query(Instrument("BSE:UTIQUE", "UTIQUE", "BSE", "500014", "UTIQUE")) == '"UTIQUE"'  # no distinct name
    assert build_query(Instrument("NIFTY", "Nifty 50", "NSE", "99926000", "Nifty 50", is_index=True)) == '"Nifty 50" OR "NIFTY"'


def test_news_needs_a_key_and_stores_it_encrypted(client, home, gnews):
    signin(client)
    client.delete("/api/news/key")
    assert client.get("/api/news/SBIN").json()["configured"] is False
    assert gnews.calls == []

    r = client.put("/api/news/key", json={"api_key": KEY})
    assert r.status_code == 200 and r.json()["configured"] and r.json()["api_key"] == "gn…56"
    assert gnews.calls[-1]["apikey"] == KEY  # verified once before saving
    db = sqlite3.connect(Path(home) / "quantvision.db")
    assert KEY not in "\n".join(db.iterdump())
    db.close()


def test_articles_use_or_query_and_are_cached(client, gnews):
    signin(client)
    client.put("/api/news/key", json={"api_key": KEY, "verify": False})
    before = client.get("/api/news/config").json()["usage"]["today"]

    first = client.get("/api/news/SBIN").json()
    assert first["query"] == '"State Bank of India" OR "SBIN"'
    assert [a["title"] for a in first["articles"]] == ['News about "State Bank of India" OR "SBIN"']  # unsafe URL dropped
    assert first["cached"] is False and first["articles"][0]["source"] == "Example Times"

    again = client.get("/api/news/SBIN").json()
    assert again["cached"] is True and len(gnews.calls) == 1
    refreshed = client.get("/api/news/SBIN", params={"refresh": True}).json()
    assert refreshed["cached"] is True  # refresh is throttled to protect the daily quota
    assert client.get("/api/news/config").json()["usage"]["today"] == before + 1


def test_custom_query_is_searched_and_cached_separately(client, gnews):
    signin(client)
    client.put("/api/news/key", json={"api_key": KEY, "verify": False})
    default = client.get("/api/news/SBIN").json()
    custom = client.get("/api/news/SBIN", params={"q": "  SBI   quarterly results "}).json()
    assert custom["query"] == "SBI quarterly results" and custom["default_query"] == default["query"]
    assert gnews.calls[-1]["q"] == "SBI quarterly results" and custom["cached"] is False
    assert client.get("/api/news/SBIN", params={"q": "SBI quarterly results"}).json()["cached"] is True
    assert client.get("/api/news/SBIN", params={"q": ""}).json()["query"] == default["query"]  # blank = default
    assert len(gnews.calls) == 2
    assert client.get("/api/news/SBIN", params={"q": "x" * 501}).status_code == 422


def test_errors_are_reported_clearly(client, gnews):
    signin(client)
    client.put("/api/news/key", json={"api_key": KEY, "verify": False})
    gnews.fail = http_error(403, "You have reached your request limit for today")
    r = client.get("/api/news/TCS")
    assert r.status_code == 502 and "daily request limit" in r.json()["detail"]
    gnews.fail = http_error(401, "Invalid API key")
    assert client.put("/api/news/key", json={"api_key": "wrong-key-000"}).status_code == 400


def test_rejected_query_falls_back_to_plain_words(client, gnews, monkeypatch):
    signin(client)
    client.put("/api/news/key", json={"api_key": KEY, "verify": False})
    calls = []

    def picky(params):
        calls.append(params["q"])
        if "&" in params["q"]:
            raise http_error(400, "Invalid query syntax")
        return {"articles": []}

    monkeypatch.setattr(news_module, "_fetch", picky)
    registry.get("M&M")
    assert client.get("/api/news/M%26M").status_code == 200
    assert calls[0] == '"Mahindra & Mahindra" OR "M&M"' and "&" not in calls[1]


def test_password_change_keeps_news_key(client):
    from tests.conftest import USER

    signin(client)
    client.put("/api/news/key", json={"api_key": KEY, "verify": False})
    current = next(p for p in (USER["password"], "an even better passphrase")
                   if client.put("/api/auth/password", json={"current_password": p, "new_password": "yet another passphrase"}).status_code == 200)
    try:
        assert client.get("/api/news/config").json()["api_key"] == "gn…56"  # re-encrypted, still readable
    finally:
        client.put("/api/auth/password", json={"current_password": "yet another passphrase", "new_password": current})
