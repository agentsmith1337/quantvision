"""Local sign-in sessions and the encrypted credential vault.

Broker credentials are encrypted with AES-256-GCM under a key derived (scrypt)
from the user's QuantVision password. The key exists only in memory between
sign-in and sign-out, so the SQLite file alone never reveals the credentials.
"""

import base64
import hashlib
import json
import secrets
import threading
import time
from dataclasses import dataclass, field

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import Cookie, HTTPException

SESSION_COOKIE = "qv_session"
SESSION_TTL = 24 * 3600

# Stronger than the password-hash parameters: this key protects broker credentials.
_VAULT_SCRYPT = {"n": 2**15, "r": 8, "p": 1, "maxmem": 64 * 1024 * 1024}


def derive_vault_key(password: str, salt: bytes) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, dklen=32, **_VAULT_SCRYPT)


def encrypt_json(key: bytes, payload: dict) -> tuple[str, str]:
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, json.dumps(payload).encode(), b"quantvision-vault-v1")
    return base64.b64encode(nonce).decode(), base64.b64encode(ct).decode()


def decrypt_json(key: bytes, nonce_b64: str, ct_b64: str) -> dict:
    data = AESGCM(key).decrypt(base64.b64decode(nonce_b64), base64.b64decode(ct_b64), b"quantvision-vault-v1")
    return json.loads(data)


@dataclass
class Session:
    token: str
    user_id: int
    username: str
    created: float = field(default_factory=time.time)


class SessionStore:
    """In-memory sessions: restarting the engine signs everyone out."""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = threading.Lock()
        self._failures: list[float] = []

    def create(self, user_id: int, username: str) -> Session:
        s = Session(secrets.token_urlsafe(32), user_id, username)
        with self._lock:
            self._sessions[s.token] = s
        return s

    def get(self, token: str | None) -> Session | None:
        if not token:
            return None
        with self._lock:
            s = self._sessions.get(token)
            if s and time.time() - s.created > SESSION_TTL:
                del self._sessions[token]
                return None
            return s

    def revoke_all(self) -> None:
        with self._lock:
            self._sessions.clear()

    # Brute-force throttle for the sign-in form.
    def check_throttle(self) -> None:
        now = time.time()
        with self._lock:
            self._failures = [t for t in self._failures if now - t < 60]
            if len(self._failures) >= 5:
                raise HTTPException(429, "Too many failed sign-in attempts. Wait a minute and try again.")

    def record_failure(self) -> None:
        with self._lock:
            self._failures.append(time.time())


sessions = SessionStore()


def require_session(qv_session: str | None = Cookie(default=None)) -> Session:
    s = sessions.get(qv_session)
    if s is None:
        raise HTTPException(401, "Sign in required")
    return s
