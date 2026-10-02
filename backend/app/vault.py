"""Encrypted storage of third-party credentials (see app.security for the crypto).

One encrypted record per provider ("angelone", "gnews"), all under the key
derived from the user's QuantVision password.
"""

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


def save(user_id: int, key: bytes, provider: str, payload: dict) -> None:
    nonce, ct = encrypt_json(key, payload)
    with SessionLocal() as db:
        row = db.query(BrokerAccount).filter_by(user_id=user_id, provider=provider).one_or_none()
        if row is None:
            db.add(BrokerAccount(user_id=user_id, provider=provider, nonce=nonce, ciphertext=ct))
        else:
            row.nonce, row.ciphertext = nonce, ct
        db.commit()


def load(user_id: int, key: bytes, provider: str) -> dict | None:
    with SessionLocal() as db:
        row = db.query(BrokerAccount).filter_by(user_id=user_id, provider=provider).one_or_none()
        if row is None:
            return None
        return decrypt_json(key, row.nonce, row.ciphertext)


def delete(user_id: int, provider: str) -> None:
    with SessionLocal() as db:
        db.query(BrokerAccount).filter_by(user_id=user_id, provider=provider).delete()
        db.commit()


def save_angel(user_id: int, key: bytes, creds: dict) -> None:
    save(user_id, key, "angelone", {k: str(creds[k]).strip() for k in ANGEL_FIELDS})


def load_angel(user_id: int, key: bytes) -> dict | None:
    return load(user_id, key, "angelone")


def delete_angel(user_id: int) -> None:
    delete(user_id, "angelone")


def rekey(user: User, old_key: bytes, new_password: str) -> bytes:
    """Re-encrypt every stored secret under a new password; returns the new key."""
    with SessionLocal() as db:
        providers = [r.provider for r in db.query(BrokerAccount).filter_by(user_id=user.id).all()]
    secrets_by_provider = {p: load(user.id, old_key, p) for p in providers}
    with SessionLocal() as db:
        row = db.get(User, user.id)
        row.vault_salt = secrets.token_hex(16)
        db.commit()
        user.vault_salt = row.vault_salt
    new_key = derive_vault_key(new_password, bytes.fromhex(user.vault_salt))
    for provider, payload in secrets_by_provider.items():
        if payload is not None:
            save(user.id, new_key, provider, payload)
    return new_key


def mask_key(value: str) -> str:
    return f"{value[:2]}…{value[-2:]}" if len(value) > 4 else "…"


def mask(creds: dict | None) -> dict | None:
    """What the UI may see: never the PIN or TOTP secret."""
    if not creds:
        return None
    return {"api_key": mask_key(creds.get("api_key", "")), "client_code": creds.get("client_code", "")}
