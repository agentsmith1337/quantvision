"""Runtime configuration, read from environment variables (and backend/.env)."""

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

LOCAL_HOSTNAMES = {"127.0.0.1", "localhost"}


@dataclass(frozen=True)
class Settings:
    home_dir: Path
    frontend_dist: Path
    # "auto": Angel One once credentials are stored in the vault, else simulated.
    # "simulated": never connect to Angel One (UI development, demos).
    market_data: str
    allowed_hosts: list[str]
    # Legacy plain-text credentials; only used as an import source by /setup.
    env_angel: dict[str, str]

    @property
    def db_path(self) -> Path:
        return self.home_dir / "quantvision.db"

    @property
    def env_angel_complete(self) -> bool:
        return all(self.env_angel.values())


def is_local_origin(origin: str) -> bool:
    parts = urlsplit(origin)
    return parts.scheme == "http" and parts.hostname in LOCAL_HOSTNAMES


def _load() -> Settings:
    home = Path(os.getenv("QV_HOME", Path.home() / "Documents" / "QuantVision")).expanduser()
    return Settings(
        home_dir=home,
        frontend_dist=Path(os.getenv("QV_FRONTEND_DIST", BACKEND_DIR.parent / "frontend" / "out")),
        market_data=os.getenv("QV_MARKET_DATA", "auto").lower(),
        allowed_hosts=os.getenv("QV_ALLOWED_HOSTS", "127.0.0.1,localhost").split(","),
        env_angel={
            "api_key": os.getenv("ANGEL_API_KEY", ""),
            "client_code": os.getenv("ANGEL_CLIENT_CODE", ""),
            "pin": os.getenv("ANGEL_PIN", ""),
            "totp_secret": os.getenv("ANGEL_TOTP_SECRET", ""),
        },
    )


settings = _load()
