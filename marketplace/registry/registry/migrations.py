"""Versioned, idempotent schema migrations for the registry SQLite database.

`SQLModel.metadata.create_all` only creates missing tables; it never changes an
existing one. Every change to an existing table is therefore a numbered
migration here. Each step is recorded in `schema_migrations` once applied, and
each step also inspects the live schema before changing it, so it is a no-op on
a database that `create_all` just created with the current models (a fresh
database records every step without doing any work).

Rules for adding a migration:
- Append a new `(number, name, function)` entry; never renumber or edit an
  applied one.
- Write explicit SQL for the schema the step produces. Do not derive it from
  the current models, which keep changing after the step is written.
- A step runs inside one transaction together with its `schema_migrations`
  row, so a failed step leaves neither behind.

Migrations run at startup from `create_db_engine`. Each step takes SQLite's
write lock (`BEGIN IMMEDIATE`) and re-reads `schema_migrations` under it, so
two processes starting against one data directory apply each step once.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from typing import Callable

from sqlalchemy import Engine

MIGRATIONS_TABLE = "schema_migrations"


def _columns(connection: sqlite3.Connection, table: str) -> set[str]:
    return {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}


def _unique_column_sets(
    connection: sqlite3.Connection, table: str
) -> set[tuple[str, ...]]:
    sets = set()
    for _seq, index, unique, origin, _partial in connection.execute(
        f"PRAGMA index_list({table})"
    ):
        if unique and origin == "u":
            columns = connection.execute(f"PRAGMA index_info({index})").fetchall()
            sets.add(tuple(row[2] for row in sorted(columns)))
    return sets


def _add_discovery_columns(connection: sqlite3.Connection) -> None:
    """Add the download/rating/curation columns to registries created before
    the discovery website (these never reached existing tables before)."""
    extension_columns = _columns(connection, "extension")
    for column, ddl in (
        ("featured", "BOOLEAN NOT NULL DEFAULT 0"),
        ("download_count", "INTEGER NOT NULL DEFAULT 0"),
        ("rating_sum", "INTEGER NOT NULL DEFAULT 0"),
        ("rating_count", "INTEGER NOT NULL DEFAULT 0"),
    ):
        if column not in extension_columns:
            connection.execute(f"ALTER TABLE extension ADD COLUMN {column} {ddl}")
    connection.execute(
        "CREATE INDEX IF NOT EXISTS ix_extension_featured ON extension (featured)"
    )
    if "download_count" not in _columns(connection, "extension_version"):
        connection.execute(
            "ALTER TABLE extension_version ADD COLUMN download_count INTEGER "
            "NOT NULL DEFAULT 0"
        )


def _add_registry_signing_columns(connection: sqlite3.Connection) -> None:
    """Add the trust columns to registries created before registry signing."""
    columns = _columns(connection, "extension_version")
    if "target" not in columns:
        connection.execute(
            "ALTER TABLE extension_version ADD COLUMN target VARCHAR "
            "NOT NULL DEFAULT 'universal'"
        )
    if "registry_envelope" not in columns:
        connection.execute(
            "ALTER TABLE extension_version ADD COLUMN registry_envelope JSON "
            "NOT NULL DEFAULT '{}'"
        )
    if "registry_signature" not in columns:
        connection.execute(
            "ALTER TABLE extension_version ADD COLUMN registry_signature VARCHAR"
        )


_VERSION_COLUMNS = (
    "id, extension_id, version, manifest, package_digest, package_key, "
    "signature, target, registry_envelope, registry_signature, trust_tier, "
    "download_count, yanked, published_at"
)

_VERSION_INDEXES = ("yanked", "trust_tier", "version", "extension_id", "target")


def _key_artifacts_by_target(connection: sqlite3.Connection) -> None:
    """Widen the version identity from (extension, version) to
    (extension, version, target) so one version can carry one artifact per
    platform target.

    SQLite cannot drop a table constraint, so the table is rebuilt with the
    documented create-new / copy / drop-old / rename procedure. Row ids are
    preserved, so `extension_asset.version_id` stays valid, and its foreign key
    text keeps naming `extension_version`, which the renamed table takes over.
    """
    unique_sets = _unique_column_sets(connection, "extension_version")
    if ("extension_id", "version", "target") in unique_sets:
        return
    connection.execute(
        """
        CREATE TABLE extension_version_new (
            id INTEGER NOT NULL,
            extension_id INTEGER NOT NULL,
            version VARCHAR NOT NULL,
            manifest JSON,
            package_digest VARCHAR NOT NULL,
            package_key VARCHAR NOT NULL,
            signature VARCHAR,
            target VARCHAR NOT NULL,
            registry_envelope JSON,
            registry_signature VARCHAR,
            trust_tier VARCHAR NOT NULL,
            download_count INTEGER NOT NULL,
            yanked BOOLEAN NOT NULL,
            published_at DATETIME NOT NULL,
            PRIMARY KEY (id),
            CONSTRAINT uq_version_target_identity
                UNIQUE (extension_id, version, target),
            FOREIGN KEY(extension_id) REFERENCES extension (id)
        )
        """
    )
    connection.execute(
        f"INSERT INTO extension_version_new ({_VERSION_COLUMNS}) "
        f"SELECT {_VERSION_COLUMNS} FROM extension_version"
    )
    connection.execute("DROP TABLE extension_version")
    connection.execute(
        "ALTER TABLE extension_version_new RENAME TO extension_version"
    )
    for column in _VERSION_INDEXES:
        connection.execute(
            f"CREATE INDEX ix_extension_version_{column} "
            f"ON extension_version ({column})"
        )


MIGRATIONS: tuple[tuple[int, str, Callable[[sqlite3.Connection], None]], ...] = (
    (1, "discovery-columns", _add_discovery_columns),
    (2, "registry-signing-columns", _add_registry_signing_columns),
    (3, "artifact-per-target", _key_artifacts_by_target),
)


def _applied(connection: sqlite3.Connection) -> dict[int, str]:
    rows = connection.execute(f"SELECT version, name FROM {MIGRATIONS_TABLE}")
    return {version: name for version, name in rows}


def applied_migrations(engine: Engine) -> dict[int, str]:
    raw = engine.raw_connection()
    try:
        return _applied(raw.driver_connection)
    finally:
        raw.close()


def run_migrations(engine: Engine) -> list[int]:
    """Apply every pending migration in order; return the numbers applied."""
    raw = engine.raw_connection()
    connection: sqlite3.Connection = raw.driver_connection
    # Autocommit mode: transactions below are explicit, so DDL is inside them
    # (the driver's implicit transactions would commit DDL on its own).
    previous_isolation = connection.isolation_level
    connection.isolation_level = None
    applied: list[int] = []
    try:
        connection.execute(
            f"CREATE TABLE IF NOT EXISTS {MIGRATIONS_TABLE} ("
            "version INTEGER NOT NULL PRIMARY KEY, "
            "name VARCHAR NOT NULL, "
            "applied_at VARCHAR NOT NULL)"
        )
        for number, name, step in MIGRATIONS:
            connection.execute("BEGIN IMMEDIATE")
            try:
                if number not in _applied(connection):
                    step(connection)
                    connection.execute(
                        f"INSERT INTO {MIGRATIONS_TABLE} "
                        "(version, name, applied_at) VALUES (?, ?, ?)",
                        (number, name, datetime.now(timezone.utc).isoformat()),
                    )
                    applied.append(number)
                connection.execute("COMMIT")
            except BaseException:
                connection.execute("ROLLBACK")
                raise
    finally:
        connection.isolation_level = previous_isolation
        raw.close()
    return applied
