"""Shared-CDN IP ranges whose connections are recorded but never light the risk pill.

A shared CDN address serves many unrelated sites, so without the hostname
(unavailable to an unprivileged observer) a connection to it says nothing
about where a CLI is sending data. General cloud providers are deliberately
absent: arbitrary attacker-controlled hosts live in their ranges.
"""

from __future__ import annotations

import ipaddress
import sqlite3
import time
from threading import Lock

from .db import Database

_COMPONENT = "cli_risk_ranges"

# Snapshots of the official published lists, embedded so matching never
# depends on a network fetch. Refresh them by hand from the source URLs.
# https://www.cloudflare.com/ips-v4/ and https://www.cloudflare.com/ips-v6/
_CLOUDFLARE = (
    "173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22",
    "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20",
    "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13",
    "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22",
    "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32",
    "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32",
)
# https://api.fastly.com/public-ip-list
_FASTLY = (
    "23.235.32.0/20", "43.249.72.0/22", "103.244.50.0/24", "103.245.222.0/23",
    "103.245.224.0/24", "104.156.80.0/20", "140.248.64.0/18", "140.248.128.0/17",
    "146.75.0.0/17", "151.101.0.0/16", "157.52.64.0/18", "167.82.0.0/17",
    "167.82.128.0/20", "167.82.160.0/20", "167.82.224.0/20", "172.111.64.0/18",
    "185.31.16.0/22", "199.27.72.0/21", "199.232.0.0/16",
    "2a04:4e40::/32", "2a04:4e42::/32",
)
BUILTIN_RANGES: tuple[tuple[str, str], ...] = (
    tuple((cidr, "Cloudflare") for cidr in _CLOUDFLARE)
    + tuple((cidr, "Fastly") for cidr in _FASTLY)
)
MAX_LABEL = 64


def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute(
        "CREATE TABLE cli_risk_shared_ranges ("
        "cidr TEXT PRIMARY KEY, label TEXT NOT NULL, "
        "source TEXT NOT NULL CHECK(source IN ('builtin','user')), "
        "enabled INTEGER NOT NULL DEFAULT 1, "
        "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
    )


def normalize_cidr(value: object) -> str:
    """Canonical network text; host bits must be zero."""
    if not isinstance(value, str) or "/" not in value:
        raise ValueError("CIDR must look like 192.0.2.0/24 or 2001:db8::/32")
    try:
        return str(ipaddress.ip_network(value.strip(), strict=True))
    except ValueError as err:
        raise ValueError(f"invalid CIDR: {err}") from None


class SharedRangeStore:
    """Table-backed range list with an in-memory match set rebuilt on edits."""

    def __init__(self, db: Database, *, clock=time.time):
        self.db = db
        self.clock = clock
        self._lock = Lock()
        self._networks: tuple[tuple[ipaddress.IPv4Network | ipaddress.IPv6Network, str], ...] = ()
        db.migrate(_COMPONENT, 1, _create_schema)
        self._seed()

    def _seed(self) -> None:
        # New builtin rows are added; an existing row (possibly disabled by
        # the user) is left untouched. Builtins dropped from the published
        # list are removed so a reassigned block stops being trusted.
        now = int(self.clock())
        builtin = {cidr for cidr, _ in BUILTIN_RANGES}
        with self.db.transaction() as cur:
            cur.executemany(
                "INSERT INTO cli_risk_shared_ranges(cidr,label,source,enabled,created_at,updated_at) "
                "VALUES(?,?,'builtin',1,?,?) ON CONFLICT(cidr) DO NOTHING",
                [(cidr, label, now, now) for cidr, label in BUILTIN_RANGES],
            )
            stale = [row["cidr"] for row in cur.execute(
                "SELECT cidr FROM cli_risk_shared_ranges WHERE source='builtin'").fetchall()
                if row["cidr"] not in builtin]
            cur.executemany("DELETE FROM cli_risk_shared_ranges WHERE cidr=?", [(c,) for c in stale])
        self._reload()

    def _reload(self) -> None:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT cidr, label FROM cli_risk_shared_ranges WHERE enabled=1").fetchall()
        self._networks = tuple((ipaddress.ip_network(row["cidr"]), row["label"]) for row in rows)

    def label_for(self, ip: str) -> str | None:
        """Label of the enabled range containing ``ip``; memory only."""
        try:
            address = ipaddress.ip_address(ip.split("%", 1)[0])
        except ValueError:
            return None
        if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
            address = address.ipv4_mapped
        for network, label in self._networks:
            if address.version == network.version and address in network:
                return label
        return None

    def list(self) -> list[dict]:
        with self.db.transaction() as cur:
            rows = cur.execute(
                "SELECT cidr,label,source,enabled,created_at,updated_at FROM cli_risk_shared_ranges "
                "ORDER BY source, label, cidr").fetchall()
        return [{"cidr": row["cidr"], "label": row["label"], "source": row["source"],
                 "enabled": bool(row["enabled"]), "createdAt": row["created_at"],
                 "updatedAt": row["updated_at"]} for row in rows]

    def add(self, cidr: object, label: object) -> None:
        cidr = normalize_cidr(cidr)
        if not isinstance(label, str) or not label.strip():
            raise ValueError("label is required")
        if len(label.strip()) > MAX_LABEL:
            raise ValueError(f"label exceeds {MAX_LABEL} characters")
        now = int(self.clock())
        with self._lock:
            with self.db.transaction() as cur:
                if cur.execute("SELECT 1 FROM cli_risk_shared_ranges WHERE cidr=?", (cidr,)).fetchone():
                    raise ValueError(f"{cidr} is already listed")
                cur.execute(
                    "INSERT INTO cli_risk_shared_ranges(cidr,label,source,enabled,created_at,updated_at) "
                    "VALUES(?,?,'user',1,?,?)", (cidr, label.strip(), now, now))
            self._reload()

    def set_enabled(self, cidr: object, enabled: object) -> None:
        if not isinstance(enabled, bool):
            raise ValueError("enabled must be a boolean")
        cidr = normalize_cidr(cidr)
        with self._lock:
            with self.db.transaction() as cur:
                cur.execute("UPDATE cli_risk_shared_ranges SET enabled=?, updated_at=? WHERE cidr=?",
                            (int(enabled), int(self.clock()), cidr))
                if cur.rowcount == 0:
                    raise ValueError(f"{cidr} is not listed")
            self._reload()

    def delete(self, cidr: object) -> None:
        cidr = normalize_cidr(cidr)
        with self._lock:
            with self.db.transaction() as cur:
                row = cur.execute("SELECT source FROM cli_risk_shared_ranges WHERE cidr=?", (cidr,)).fetchone()
                if row is None:
                    raise ValueError(f"{cidr} is not listed")
                if row["source"] != "user":
                    raise ValueError("built-in ranges can be disabled but not deleted")
                cur.execute("DELETE FROM cli_risk_shared_ranges WHERE cidr=?", (cidr,))
            self._reload()
