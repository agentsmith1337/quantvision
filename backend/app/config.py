"""Runtime configuration, read from environment variables (and backend/.env)."""

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")


@dataclass(frozen=True)
class Settings:
    home_dir: Path
    frontend_dist: Path
    # "auto" uses Angel One when credentials are present, else the simulated feed.
    market_data: str
    angel_api_key: str
    angel_client_code: str
    angel_pin: str
    angel_totp_secret: str

    @property
    def db_path(self) -> Path:
        return self.home_dir / "quantvision.db"

    @property
    def angel_configured(self) -> bool:
        return all((self.angel_api_key, self.angel_client_code, self.angel_pin, self.angel_totp_secret))


def _load() -> Settings:
    home = Path(os.getenv("QV_HOME", Path.home() / "Documents" / "QuantVision")).expanduser()
    return Settings(
        home_dir=home,
        frontend_dist=Path(os.getenv("QV_FRONTEND_DIST", BACKEND_DIR.parent / "frontend" / "out")),
        market_data=os.getenv("QV_MARKET_DATA", "auto").lower(),
        angel_api_key=os.getenv("ANGEL_API_KEY", ""),
        angel_client_code=os.getenv("ANGEL_CLIENT_CODE", ""),
        angel_pin=os.getenv("ANGEL_PIN", ""),
        angel_totp_secret=os.getenv("ANGEL_TOTP_SECRET", ""),
    )


settings = _load()
