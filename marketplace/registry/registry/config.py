"""Runtime settings resolved from the environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

ENV_DATA_DIR = "REGISTRY_DATA_DIR"
DEFAULT_DATA_DIR = ".registry-data"

ENV_VERIFIER = "REGISTRY_VERIFIER"
ENV_REQUIRE_SIGNATURE = "REGISTRY_REQUIRE_SIGNATURE"
ENV_REQUIRE_AUTH = "REGISTRY_REQUIRE_AUTH"
ENV_ADMIN_TOKEN = "REGISTRY_ADMIN_TOKEN"

# Verifier kinds.
VERIFIER_ED25519 = "ed25519"
VERIFIER_ACCEPTING = "accepting"


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    # Security policy. Production defaults are strict; the test/dev harness
    # opts into a permissive configuration explicitly (see tests/conftest.py).
    verifier_kind: str = VERIFIER_ED25519
    """Which SignatureVerifier to install: 'ed25519' (real) or 'accepting' (dev)."""
    require_signature: bool = True
    """Reject unsigned publishes unless False (dev)."""
    require_auth: bool = True
    """Reject anonymous publishes/yanks unless False (dev)."""
    admin_token: str | None = None
    """Bearer token gating publisher registration; None leaves it open (dev)."""

    @property
    def db_path(self) -> Path:
        return self.data_dir / "registry.db"

    @property
    def storage_root(self) -> Path:
        return self.data_dir / "packages"


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def load_settings() -> Settings:
    data_dir = Path(os.environ.get(ENV_DATA_DIR, DEFAULT_DATA_DIR))
    return Settings(
        data_dir=data_dir,
        verifier_kind=os.environ.get(ENV_VERIFIER, VERIFIER_ED25519),
        require_signature=_env_bool(ENV_REQUIRE_SIGNATURE, True),
        require_auth=_env_bool(ENV_REQUIRE_AUTH, True),
        admin_token=os.environ.get(ENV_ADMIN_TOKEN),
    )
