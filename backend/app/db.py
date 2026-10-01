"""SQLite storage for users and app configuration."""

from collections.abc import Iterator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from app.config import settings


class Base(DeclarativeBase):
    pass


settings.home_dir.mkdir(parents=True, exist_ok=True)
engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False},
)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def init_db() -> None:
    from app import models  # noqa: F401  (registers tables on Base.metadata)

    Base.metadata.create_all(engine)
    _migrate()


def _migrate() -> None:
    """Add columns introduced after a table was first created (SQLite has no auto-migrate)."""
    from sqlalchemy import inspect, text

    added = {"users": {"vault_salt": "VARCHAR(64)"}}
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, columns in added.items():
            existing = {c["name"] for c in insp.get_columns(table)}
            for name, ddl in columns.items():
                if name not in existing:
                    conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))


def get_session() -> Iterator[Session]:
    with SessionLocal() as session:
        yield session
