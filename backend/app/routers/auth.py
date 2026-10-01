import re
from typing import Annotated, Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from app import prefs, vault
from app.config import settings
from app.db import SessionLocal
from app.engine import engine
from app.models import User
from app.routers.broker import AngelCredentials, StaticIps
from app.security import SESSION_COOKIE, SESSION_TTL, Session, require_session, sessions

router = APIRouter(prefix="/api/auth")

AVATAR_TYPES = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
AVATAR_MAX_BYTES = 2 * 1024 * 1024


class Credentials(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=8, max_length=256)

    @field_validator("username")
    @classmethod
    def _username(cls, v: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", v):
            raise ValueError("Use letters, digits, '.', '_' or '-'")
        return v


class SetupRequest(Credentials):
    angel: AngelCredentials | None = None
    import_env: bool = False  # take Angel One credentials from backend/.env
    static_ips: StaticIps = StaticIps()
    trading_mode: Literal["paper", "live"] = "paper"


def _user() -> User | None:
    with SessionLocal() as db:
        return db.query(User).first()


def _set_cookie(response: Response, session: Session) -> None:
    response.set_cookie(SESSION_COOKIE, session.token, max_age=SESSION_TTL, httponly=True, samesite="strict", path="/")


def _profile(user: User) -> dict:
    return {"username": user.username, "has_avatar": bool(user.profile_picture)}


@router.get("/status")
def status(qv_session: Annotated[str | None, Cookie()] = None) -> dict:
    user = _user()
    session = sessions.get(qv_session)
    return {
        "setup_complete": user is not None,
        "signed_in": session is not None,
        "user": _profile(user) if user and session else None,
        "env_credentials_available": settings.env_angel_complete,
    }


def _unlock(user: User, password: str) -> None:
    key = vault.vault_key_for(user, password)
    engine.start(user.id, key, vault.load_angel(user.id, key))


@router.post("/setup")
async def setup(body: SetupRequest, response: Response) -> dict:
    if _user() is not None:
        raise HTTPException(409, "QuantVision is already set up; sign in instead")
    creds = settings.env_angel if body.import_env else (body.angel.model_dump() if body.angel else None)
    if body.import_env and not settings.env_angel_complete:
        raise HTTPException(400, "backend/.env doesn't contain all four ANGEL_* values")
    if body.trading_mode == "live" and not creds:
        raise HTTPException(400, "Live trading needs Angel One credentials")

    def create() -> User:
        with SessionLocal() as db:
            user = User(username=body.username)
            user.set_password(body.password)
            db.add(user)
            db.commit()
            db.refresh(user)
        key = vault.vault_key_for(user, body.password)
        if creds:
            vault.save_angel(user.id, key, creds)
        prefs.put("static_ips", body.static_ips.model_dump())
        prefs.put("trading_mode", body.trading_mode)
        engine.start(user.id, key, creds)
        return user

    user = await run_in_threadpool(create)
    _set_cookie(response, sessions.create(user.id, user.username))
    return _profile(user)


@router.post("/signin")
async def signin(body: Credentials, response: Response) -> dict:
    sessions.check_throttle()
    user = _user()
    ok = user is not None and user.username == body.username and await run_in_threadpool(user.check_password, body.password)
    if not ok:
        sessions.record_failure()
        raise HTTPException(401, "Incorrect user ID or password")
    if not engine.running or engine.user_id != user.id:
        await run_in_threadpool(_unlock, user, body.password)
    _set_cookie(response, sessions.create(user.id, user.username))
    return _profile(user)


@router.post("/signout")
def signout(response: Response, _: Annotated[Session, Depends(require_session)]) -> dict:
    # Signing out locks the engine: the vault key is dropped from memory.
    sessions.revoke_all()
    engine.stop()
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"signed_in": False}


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=256)


@router.put("/password")
def change_password(body: PasswordChange, s: Annotated[Session, Depends(require_session)]) -> dict:
    user = _user()
    if user is None or not user.check_password(body.current_password):
        raise HTTPException(403, "Current password is incorrect")
    old_key = vault.vault_key_for(user, body.current_password)
    new_key = vault.rekey(user, old_key, body.new_password)
    with SessionLocal() as db:
        row = db.get(User, user.id)
        row.set_password(body.new_password)
        db.commit()
    engine.vault_key = new_key
    return {"changed": True}


@router.post("/avatar")
async def upload_avatar(file: UploadFile, _: Annotated[Session, Depends(require_session)]) -> dict:
    ext = AVATAR_TYPES.get(file.content_type or "")
    if ext is None:
        raise HTTPException(415, "Use a PNG, JPEG or WebP image")
    data = await file.read(AVATAR_MAX_BYTES + 1)
    if len(data) > AVATAR_MAX_BYTES:
        raise HTTPException(413, "Image must be 2 MB or smaller")
    user = _user()
    for old in settings.home_dir.glob("avatar.*"):
        old.unlink()
    path = settings.home_dir / f"avatar{ext}"
    path.write_bytes(data)
    with SessionLocal() as db:
        db.get(User, user.id).profile_picture = path.name
        db.commit()
    return {"has_avatar": True}


@router.get("/avatar")
def get_avatar(_: Annotated[Session, Depends(require_session)]) -> FileResponse:
    user = _user()
    if user is None or not user.profile_picture:
        raise HTTPException(404, "No profile picture")
    return FileResponse(settings.home_dir / user.profile_picture, headers={"Cache-Control": "no-store"})
