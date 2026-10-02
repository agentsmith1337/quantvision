import hashlib
import hmac
import secrets
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def _now() -> datetime:
    return datetime.now(UTC)


class User(Base):
    """A local QuantVision account (sign-in to the app, not to Angel One)."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    profile_picture: Mapped[str | None] = mapped_column(String(512), default=None)
    vault_salt: Mapped[str | None] = mapped_column(String(64), default=None)  # hex; see app.vault
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    def set_password(self, password: str) -> None:
        self.password_hash = hash_password(password)

    def check_password(self, password: str) -> bool:
        return verify_password(password, self.password_hash)


class AppSetting(Base):
    """Key/value app configuration (watchlists, feature toggles, UI preferences)."""

    __tablename__ = "settings"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class BrokerAccount(Base):
    """Broker credentials, encrypted with a key derived from the owner's password."""

    __tablename__ = "broker_accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    provider: Mapped[str] = mapped_column(String(32), default="angelone")
    nonce: Mapped[str] = mapped_column(String(32))  # base64
    ciphertext: Mapped[str] = mapped_column(Text)  # base64
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now, onupdate=_now)


class InstrumentRow(Base):
    """Instruments discovered via search or holdings, so their tokens survive restarts."""

    __tablename__ = "instruments"

    symbol: Mapped[str] = mapped_column(String(64), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(8))
    trading_symbol: Mapped[str] = mapped_column(String(64))
    token: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(128))
    is_index: Mapped[bool] = mapped_column(default=False)


# scrypt from the stdlib: no native build dependency, memory-hard.
_SCRYPT = {"n": 2**14, "r": 8, "p": 1}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        scheme, salt_hex, digest_hex = stored.split("$")
    except ValueError:
        return False
    if scheme != "scrypt":
        return False
    digest = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), **_SCRYPT)
    return hmac.compare_digest(digest.hex(), digest_hex)
