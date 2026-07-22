"""One-time, on-startup backup + forward-migration of persisted JSON stores.

When a NEW app version's backend starts for the first time we:

1. BACKUP the persisted app-data JSON stores into
   ``<app-data>/store-backups/<version>/`` (keeping the most recent 2 backup
   dirs), so a version upgrade can never silently corrupt a user's saved data.
2. MIGRATE each versioned store forward to the current schema via a registry
   keyed by ``schemaVersion``. At schema v1 the registry is empty, so this is a
   clean identity/no-op — the extension point exists for future bumps.
3. Record the current backend version in a marker file so the next same-version
   start is a fast no-op.

Everything here is best-effort: it is idempotent and must NEVER raise or block
backend startup. Errors are caught and logged. It never deletes user data
(only prunes its own older backup directories).
"""

from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path
from typing import Any, Callable

from . import __version__
from .applog import app_data_dir
from .roles_store import ROLES_FILE
from .stages_store import PIPELINES_FILE, SCHEMA_VERSION as STORE_SCHEMA_VERSION
from .tokens_store import TOKENS_FILE

log = logging.getLogger("agent_team_backend.store_migrations")

# Marker holding the last backend version that ran against this app-data dir.
MARKER_FILE = ".navide-last-version"
# Subdir under app-data holding per-version backup copies.
BACKUP_DIR = "store-backups"
# How many most-recent backup dirs to keep; older ones are pruned.
KEEP_BACKUPS = 2

# The canonical user-data JSON stores that live directly under app-data.
# Derived token caches (recorded-event-keys.json, ingestion-state, journal) and
# per-workspace project.json are intentionally excluded — they self-heal.
STORE_FILENAMES: tuple[str, ...] = (PIPELINES_FILE, ROLES_FILE, TOKENS_FILE)

# Forward-migration registry: maps a store's current schemaVersion N to a
# function that upgrades a parsed doc from N to N+1. Empty at schema v1.
# To add a migration when STORE_SCHEMA_VERSION is bumped:
#     _MIGRATIONS[1] = _migrate_v1_to_v2
_MIGRATIONS: dict[int, Callable[[dict[str, Any]], dict[str, Any]]] = {}


def run_startup_migrations(
    data_dir: Path | None = None, current_version: str | None = None
) -> None:
    """Entry point called once on backend startup. Never raises.

    Backs up + forward-migrates the persisted stores when the backend version
    changed since the last run (or the marker is missing but stores exist).
    Same version → no backup, no-op.
    """
    try:
        _run(data_dir, current_version)
    except Exception as err:  # noqa: BLE001
        # Data protection must never block startup.
        log.warning("store backup/migration failed (non-fatal): %s", err)


def _run(data_dir: Path | None, current_version: str | None) -> None:
    base = data_dir or app_data_dir()
    version = current_version or __version__
    marker = base / MARKER_FILE
    last = _read_marker(marker)

    if last == version:
        return  # Same version already recorded — nothing to do.

    stores_exist = any((base / name).exists() for name in STORE_FILENAMES)
    if last is None and not stores_exist:
        # Fresh install: no prior data to protect. Just stamp the version.
        _write_marker(marker, version)
        return

    # Version changed (or marker missing but stores exist) → protect data.
    _backup_stores(base, version)
    _run_migrations(base)
    _write_marker(marker, version)
    log.info("store data protected for version upgrade %s -> %s", last, version)


# ─────────────────────────── marker ────────────────────────────


def _read_marker(marker: Path) -> str | None:
    try:
        text = marker.read_text(encoding="utf-8").strip()
        return text or None
    except (OSError, ValueError):
        return None


def _write_marker(marker: Path, version: str) -> None:
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(version, encoding="utf-8")


# ─────────────────────────── backup ────────────────────────────


def _backup_stores(base: Path, version: str) -> None:
    dest = base / BACKUP_DIR / version
    dest.mkdir(parents=True, exist_ok=True)
    copied = 0
    for name in STORE_FILENAMES:
        src = base / name
        if src.exists():
            shutil.copy2(src, dest / name)
            copied += 1
    log.info("backed up %d store file(s) to %s", copied, dest)
    _prune_backups(base / BACKUP_DIR)


def _prune_backups(backup_root: Path) -> None:
    """Keep only the KEEP_BACKUPS most recently modified backup dirs."""
    try:
        dirs = [d for d in backup_root.iterdir() if d.is_dir()]
    except OSError:
        return
    if len(dirs) <= KEEP_BACKUPS:
        return
    dirs.sort(key=lambda d: d.stat().st_mtime)
    for old in dirs[:-KEEP_BACKUPS]:
        shutil.rmtree(old, ignore_errors=True)


# ────────────────────────── migration ──────────────────────────


def apply_migrations(doc: Any) -> Any:
    """Forward-migrate a parsed store doc to STORE_SCHEMA_VERSION.

    Identity at schema v1 (empty registry). Bare-list stores (roles.json) carry
    no schemaVersion and pass through unchanged.
    """
    if not isinstance(doc, dict):
        return doc
    version = _coerce_version(doc.get("schemaVersion", 1))
    while version < STORE_SCHEMA_VERSION and version in _MIGRATIONS:
        doc = _MIGRATIONS[version](doc)
        version += 1
    return doc


def _coerce_version(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 1


def _run_migrations(base: Path) -> None:
    """Apply forward migrations to each versioned store file in place.

    At schema v1 the registry is empty so this reads and re-serializes nothing
    (docs come back unchanged → no write). Newer files (schemaVersion higher
    than we support) are left untouched.
    """
    for name in STORE_FILENAMES:
        path = base / name
        if not path.exists():
            continue
        try:
            _migrate_file(path)
        except Exception as err:  # noqa: BLE001
            log.warning("migration of %s failed (non-fatal): %s", path, err)


def _migrate_file(path: Path) -> None:
    doc = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(doc, dict):
        return  # bare-list store; nothing to migrate
    version = _coerce_version(doc.get("schemaVersion", 1))
    if version > STORE_SCHEMA_VERSION:
        # Newer than we understand — do not touch it.
        return
    migrated = apply_migrations(doc)
    if migrated is not doc:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(
            json.dumps(migrated, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        tmp.replace(path)
