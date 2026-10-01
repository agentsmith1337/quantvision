"""Encrypted storage of broker credentials (see app.security for the crypto)."""

import secrets

from app.db import SessionLocal
from app.models import BrokerAccount, User
from app.security import decrypt_json, derive_vault_key, encrypt_json

ANGEL_FIELDS = ("api_key", "client_code", "pin", "totp_secret")


def vault_key_for(user: User, password: str) -> bytes:
    """Derive the user's vault key, creating their salt on first use."""
    if not user.vault_salt:
        with SessionLocal() as db:
            row = db.get(User, user.id)
            row.vault_salt = secrets.token_hex(16)
            db.commit()
            user.vault_salt = row.vault_salt
    return derive_vault_key(password, bytes.fromhex(user.vault_salt))


def save_angel(user_id: int, key: bytes, creds: dict) -> None:
    payload = {k: str(creds[k]).strip() for k in ANGEL_FIELDS}
    nonce, ct = encrypt_json(key, payload)
    with SessionLocal() as db:
        row = db.query(BrokerAccount).filter_by(user_id=user_id, provider="angelone").one_or_none()
        if row is None:
            db.add(BrokerAccount(user_id=user_id, provider="angelone", nonce=nonce, ciphertext=ct))
        else:
            row.nonce, row.ciphertext = nonce, ct
        db.commit()


def load_angel(user_id: int, key: bytes) -> dict | None:
    with SessionLocal() as db:
        row = db.query(BrokerAccount).filter_by(user_id=user_id, provider="angelone").one_or_none()
        if row is None:
            return None
        return decrypt_json(key, row.nonce, row.ciphertext)


def delete_angel(user_id: int) -> None:
    with SessionLocal() as db:
        db.query(BrokerAccount).filter_by(user_id=user_id, provider="angelone").delete()
        db.commit()


def rekey(user: User, old_key: bytes, new_password: str) -> bytes:
    """Re-encrypt the vault under a new password; returns the new key."""
    creds = load_angel(user.id, old_key)
    with SessionLocal() as db:
        row = db.get(User, user.id)
        row.vault_salt = secrets.token_hex(16)
        db.commit()
        user.vault_salt = row.vault_salt
    new_key = derive_vault_key(new_password, bytes.fromhex(user.vault_salt))
    if creds is not None:
        save_angel(user.id, new_key, creds)
    return new_key


def mask(creds: dict | None) -> dict | None:
    """What the UI may see: never the PIN or TOTP secret."""
    if not creds:
        return None
    key = creds.get("api_key", "")
    return {"api_key": f"{key[:2]}…{key[-2:]}" if len(key) > 4 else "…", "client_code": creds.get("client_code", "")}
