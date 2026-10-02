from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field

from app import vault
from app.engine import engine
from app.market.instruments import registry
from app.news import NewsError, news
from app.security import require_session

router = APIRouter(prefix="/api/news", dependencies=[Depends(require_session)])


def _unlocked() -> tuple[int, bytes]:
    if engine.user_id is None or engine.vault_key is None:
        raise HTTPException(409, "Engine is locked; sign in again")
    return engine.user_id, engine.vault_key


@router.get("/config")
def config() -> dict:
    key = news.key(engine.user_id, engine.vault_key)
    return {"configured": key is not None, "api_key": vault.mask_key(key) if key else None, "usage": news.usage()}


class KeyBody(BaseModel):
    api_key: str = Field(min_length=8, max_length=128)
    verify: bool = True


@router.put("/key")
async def save_key(body: KeyBody) -> dict:
    user_id, key = _unlocked()
    api_key = body.api_key.strip()
    if body.verify:
        try:
            await run_in_threadpool(news.verify, api_key)
        except NewsError as e:
            raise HTTPException(400, f"{e}. Nothing was saved.") from e
    vault.save(user_id, key, "gnews", {"api_key": api_key})
    return config()


@router.delete("/key")
def delete_key() -> dict:
    user_id, _ = _unlocked()
    vault.delete(user_id, "gnews")
    return config()


@router.get("/{symbol}")
async def stock_news(symbol: str, refresh: bool = False) -> dict:
    inst = registry.get(symbol)
    if inst is None:
        raise HTTPException(404, f"Unknown symbol {symbol}")
    api_key = news.key(engine.user_id, engine.vault_key)
    if api_key is None:
        return {"symbol": inst.symbol, "configured": False, "articles": [], "usage": news.usage()}
    try:
        payload = await run_in_threadpool(news.articles, inst, api_key, refresh)
    except NewsError as e:
        raise HTTPException(502, str(e)) from e
    return {**payload, "configured": True, "usage": news.usage()}
