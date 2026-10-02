"""Stock news from GNews (https://gnews.io).

Each request searches for the company name OR the base symbol, e.g.
"Reliance Industries" OR "RELIANCE", for the widest article coverage. Results are
cached per stock because the free plan allows about 100 requests a day.
"""

import json
import logging
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from app import prefs, vault
from app.market.instruments import Instrument

log = logging.getLogger(__name__)

GNEWS_URL = "https://gnews.io/api/v4/search"
DAILY_LIMIT = 100  # GNews free plan
CACHE_SECONDS = 30 * 60
MIN_REFRESH_SECONDS = 120
MAX_ARTICLES = 10
IST = timezone(timedelta(hours=5, minutes=30))


class NewsError(Exception):
    """A problem worth showing the user (bad key, quota, network)."""


def base_symbol(inst: Instrument) -> str:
    return inst.trading_symbol.removesuffix("-EQ").upper() if not inst.is_index else inst.symbol.split(":")[-1]


def build_query(inst: Instrument) -> str:
    """'"Company Name" OR "SYMBOL"'; just the symbol when no distinct name is known."""
    base = base_symbol(inst)
    terms = []
    name = inst.name.strip()
    if name and name.upper() != base.upper():
        terms.append(f'"{name}"')
    terms.append(f'"{base}"')
    return " OR ".join(terms)


def _simplify(query: str) -> str:
    """Fallback query without characters GNews may reject (e.g. "&")."""
    return re.sub(r"[^A-Za-z0-9 \"]", " ", query).replace('  ', ' ')


def _fetch(params: dict) -> dict:
    url = f"{GNEWS_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "QuantVision"})
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.loads(res.read().decode("utf-8"))


class NewsService:
    def __init__(self) -> None:
        self._cache: dict[str, tuple[float, dict]] = {}
        self._lock = threading.Lock()

    # --- key management (stored encrypted in the vault) -----------------------------------

    def key(self, user_id: int | None, vault_key: bytes | None) -> str | None:
        if user_id is None or vault_key is None:
            return None
        stored = vault.load(user_id, vault_key, "gnews")
        return stored.get("api_key") if stored else None

    def verify(self, api_key: str) -> None:
        self._request({"q": '"NIFTY"', "lang": "en", "max": 1, "apikey": api_key})

    # --- usage ---------------------------------------------------------------------------------

    def usage(self) -> dict:
        today = datetime.now(IST).date().isoformat()
        used = prefs.get("news_usage") or {}
        return {"today": used.get("count", 0) if used.get("date") == today else 0, "limit": DAILY_LIMIT}

    def _count_request(self) -> None:
        today = datetime.now(IST).date().isoformat()
        with self._lock:
            used = prefs.get("news_usage") or {}
            count = used.get("count", 0) if used.get("date") == today else 0
            prefs.put("news_usage", {"date": today, "count": count + 1})

    # --- articles ------------------------------------------------------------------------------

    def articles(self, inst: Instrument, api_key: str, refresh: bool = False) -> dict:
        now = time.time()
        with self._lock:
            hit = self._cache.get(inst.symbol)
        if hit and (now - hit[0] < (MIN_REFRESH_SECONDS if refresh else CACHE_SECONDS)):
            return {**hit[1], "cached": True}

        query = build_query(inst)
        params = {"q": query, "lang": "en", "max": MAX_ARTICLES, "sortby": "publishedAt", "apikey": api_key}
        try:
            data = self._request(params)
        except NewsError as e:
            if "query" not in str(e).lower() or _simplify(query) == query:
                raise
            params["q"] = query = _simplify(query)
            data = self._request(params)

        payload = {
            "symbol": inst.symbol,
            "query": query,
            "fetched_at": datetime.now(IST).isoformat(),
            "articles": [
                {
                    "title": a.get("title", ""),
                    "description": a.get("description", ""),
                    "url": a.get("url", ""),
                    "image": a.get("image"),
                    "published_at": a.get("publishedAt"),
                    "source": (a.get("source") or {}).get("name", ""),
                }
                for a in data.get("articles", [])
                if str(a.get("url", "")).startswith(("https://", "http://"))
            ],
        }
        with self._lock:
            self._cache[inst.symbol] = (now, payload)
        return {**payload, "cached": False}

    def _request(self, params: dict) -> dict:
        self._count_request()
        try:
            return _fetch(params)
        except urllib.error.HTTPError as e:
            try:
                detail = "; ".join(json.loads(e.read().decode("utf-8")).get("errors", []))
            except Exception:
                detail = ""
            if e.code == 401:
                raise NewsError("GNews rejected the API key (Settings → News)") from e
            if e.code == 403:
                raise NewsError(f"GNews daily request limit reached{': ' + detail if detail else ''}") from e
            if e.code == 429:
                raise NewsError("GNews is rate-limiting requests; try again in a minute") from e
            raise NewsError(f"GNews error {e.code}{': ' + detail if detail else ''}") from e
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            raise NewsError(f"Couldn't reach GNews: {getattr(e, 'reason', e)}") from e


news = NewsService()
