"""SQLite engine + schema setup (changes to existing tables: migrations.py)."""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine
from sqlmodel import SQLModel, create_engine

# Import models so their tables register on SQLModel.metadata.
from . import models  # noqa: F401
from .migrations import run_migrations


def create_db_engine(db_path: Path | str) -> Engine:
    path = Path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{path}",
        connect_args={"check_same_thread": False},
    )
    SQLModel.metadata.create_all(engine)
    run_migrations(engine)
    return engine
