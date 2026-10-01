import ipaddress
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field, field_validator

from app import prefs, vault
from app.broker.angel import AngelSession
from app.broker.base import BrokerError
from app.config import settings
from app.engine import engine
from app.market.hub import hub
from app.security import require_session

router = APIRouter(prefix="/api/broker", dependencies=[Depends(require_session)])


class AngelCredentials(BaseModel):
    api_key: str = Field(min_length=1, max_length=64)
    client_code: str = Field(min_length=1, max_length=32)
    pin: str = Field(min_length=4, max_length=16)
    totp_secret: str = Field(min_length=16, max_length=64)

    @field_validator("api_key", "client_code", "pin", "totp_secret")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("totp_secret")
    @classmethod
    def _base32(cls, v: str) -> str:
        v = v.replace(" ", "").upper()
        if not all(c in "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567=" for c in v):
            raise ValueError("The TOTP secret is the base32 text key (letters A-Z and digits 2-7), not the 6-digit code")
        return v


class StaticIps(BaseModel):
    primary: str = ""
    secondary: str = ""

    @field_validator("primary", "secondary")
    @classmethod
    def _ip(cls, v: str) -> str:
        v = v.strip()
        if v:
            ipaddress.IPv4Address(v)
        return v


class CredentialsUpdate(BaseModel):
    angel: AngelCredentials | None = None
    import_env: bool = False
    verify: bool = True  # log in once before saving


@router.get("/status")
def status() -> dict:
    creds = vault.load_angel(engine.user_id, engine.vault_key) if engine.vault_key else None
    return {
        "market": hub.status.to_message(),
        "trading_mode": engine.trading_mode,
        "live_available": engine.live is not None,
        "credentials": vault.mask(creds),
        "env_credentials_available": settings.env_angel_complete,
        "simulated_only": settings.market_data == "simulated",
    }


@router.put("/credentials")
async def save_credentials(body: CredentialsUpdate) -> dict:
    if engine.vault_key is None or engine.user_id is None:
        raise HTTPException(409, "Engine is locked; sign in again")
    if body.import_env:
        if not settings.env_angel_complete:
            raise HTTPException(400, "backend/.env doesn't contain all four ANGEL_* values")
        creds = dict(settings.env_angel)
    elif body.angel:
        creds = body.angel.model_dump()
    else:
        raise HTTPException(422, "Provide credentials or set import_env")
    if body.verify:
        try:
            await run_in_threadpool(AngelSession(creds).login)
        except BrokerError as e:
            raise HTTPException(400, f"{e}. Nothing was saved.") from e
    user_id, key = engine.user_id, engine.vault_key
    vault.save_angel(user_id, key, creds)
    await run_in_threadpool(engine.start, user_id, key, creds)
    return {"credentials": vault.mask(creds)}


@router.delete("/credentials")
async def delete_credentials() -> dict:
    if engine.vault_key is None or engine.user_id is None:
        raise HTTPException(409, "Engine is locked; sign in again")
    user_id, key = engine.user_id, engine.vault_key
    vault.delete_angel(user_id)
    prefs.put("trading_mode", "paper")
    await run_in_threadpool(engine.start, user_id, key, None)
    return {"credentials": None}


class ModeUpdate(BaseModel):
    mode: Literal["paper", "live"]


@router.put("/mode")
def set_mode(body: ModeUpdate) -> dict:
    return {"trading_mode": engine.set_trading_mode(body.mode)}


@router.get("/ip-check")
async def ip_check(refresh: bool = False) -> dict:
    return await run_in_threadpool(engine.ip_check, refresh)
