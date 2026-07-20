"""Runtime settings resolved from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ENV_DATA_DIR = "REGISTRY_DATA_DIR"
DEFAULT_DATA_DIR = ".registry-data"


@dataclass(frozen=True)
class Settings:
    data_dir: Path

    @property
    def db_path(self) -> Path:
        return self.data_dir / "registry.db"

    @property
    def storage_root(self) -> Path:
        return self.data_dir / "packages"


def load_settings() -> Settings:
    data_dir = Path(os.environ.get(ENV_DATA_DIR, DEFAULT_DATA_DIR))
    return Settings(data_dir=data_dir)
