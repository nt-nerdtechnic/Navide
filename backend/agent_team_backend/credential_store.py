"""One persistent, nonsecret credential destination per managed vendor."""
from __future__ import annotations

import hashlib
import time
from pathlib import Path

from .cli_vendors.base import VendorRuntimeContext
from .cli_vendors.registry import VENDORS


class StoreUnverified(ValueError):
    pass


class CredentialStores:
    def __init__(self, db, active_metadata) -> None:
        self._db = db
        self._active_metadata = active_metadata

    def enabled(self, agent_key: str) -> bool:
        spec = VENDORS.get(agent_key)
        return bool(spec and spec.live_file_from_context)

    def _record(self, agent_key: str) -> dict | None:
        return self._db.kv_get("credential-store:" + agent_key)

    def context(self, agent_key: str) -> VendorRuntimeContext:
        record = self._record(agent_key)
        if not record:
            raise StoreUnverified(f"{agent_key}: open a standard CLI pane to verify its credential store first")
        ctx = VendorRuntimeContext(Path(record["home"]), record["env"], Path(record["cwd"]))
        path = VENDORS[agent_key].live_file_from_context(ctx).resolve()
        if str(path) != record["path"]:
            raise StoreUnverified(f"{agent_key}: credential store destination changed; verify it again")
        return ctx

    def path(self, agent_key: str) -> Path:
        return VENDORS[agent_key].live_file_from_context(self.context(agent_key)).resolve()

    def store_id(self, agent_key: str) -> str:
        return hashlib.sha256(str(self.path(agent_key)).encode()).hexdigest()

    def matches(self, agent_key: str, metadata: dict) -> bool:
        try:
            return (metadata.get("credential_store_verified") is True
                    and metadata.get("credential_store_id") == self.store_id(agent_key))
        except StoreUnverified:
            return False

    def require_mutation(self, agent_key: str) -> None:
        if not self.enabled(agent_key):
            return
        self.context(agent_key)
        for metadata in self._active_metadata(agent_key):
            if not self.matches(agent_key, metadata):
                raise StoreUnverified(f"{agent_key}: a running pane has an unknown or conflicting credential store; close it before changing accounts")

    def bind(self, agent_key: str, report: dict, *, vault, slot_id: str, scope: str | None,
             has_managed_state: bool = False, exclude_term_id: str = "",
             new_login_profile: bool = False) -> str:
        """Called under the vendor lock, before the reported CLI receives GO.

        A first binding never replaces a different existing live store. A
        populated active slot must match the candidate account. Unknown old
        panes prevent adoption; persisted metadata is not launch evidence.
        """
        from .credential_vault import LiveCredentials, _read_text, _read_private_text
        from .quota_failover import account_identity, secrets_equal

        if not report["verified"]:
            raise StoreUnverified(f"{agent_key}: custom command cannot verify its credential store")
        spec = VENDORS[agent_key]
        if set(report["env"]) - set(spec.credential_path_env_vars):
            raise StoreUnverified("unexpected credential path input")
        path_env = {name: report["env"][name] for name in spec.credential_path_env_vars if name in report["env"]}
        ctx = VendorRuntimeContext(Path(report["home"]), path_env, Path(report["cwd"]))
        # Normalize backend path inputs only; the helper execs the untouched
        # CLI environment. Relative XDG values must retain the launch cwd.
        ctx = VendorRuntimeContext(ctx.home, {
            key: str(ctx.path(value)) if value else value for key, value in ctx.env.items()
        }, ctx.cwd)
        path = spec.live_file_from_context(ctx).resolve()
        identity = hashlib.sha256(str(path).encode()).hexdigest()
        existing = self._record(agent_key)
        if existing:
            if self.store_id(agent_key) != identity:
                raise StoreUnverified(f"{agent_key}: this pane uses a different credential store from the managed accounts")
            return identity
        if any(meta.get("credential_launch_term_id") != exclude_term_id or not exclude_term_id
               for meta in self._active_metadata(agent_key)):
            raise StoreUnverified(f"{agent_key}: close existing panes before adopting a credential store")
        legacy = spec.live_file_resolver(vault._real_home).resolve()
        # A newly created empty login target is not prior account ownership,
        # but that exception only applies to the existing canonical store.
        has_managed_state |= new_login_profile and legacy != path
        if legacy != path and legacy.exists():
            raise StoreUnverified(f"{agent_key}: the existing and launched credential stores differ; choose which store to manage before switching")
        secret = _read_text(path)
        if scope is not None:
            secret = vault._extract(agent_key, secret, scope)
        if scope is None and len(spec.account_switch.scopes) > 1 and slot_id == "__default__":
            current = LiveCredentials(_read_private_text(vault.slot_dir(agent_key, slot_id) / spec.slot_file))
        else:
            current = vault.read_slot(agent_key, slot_id, scope=scope)
        vendor_root = vault._root / agent_key
        has_managed_state |= any(p.parent.name != slot_id for p in vendor_root.glob("*/" + spec.slot_file))
        if current.secret is not None and not secrets_equal(current.secret, secret):
            live_identity = account_identity(vault, agent_key, None, scope, creds=LiveCredentials(secret))
            slot_identity = account_identity(vault, agent_key, slot_id, scope, creds=current)
            if not any(live_identity.get(key) and live_identity[key] == slot_identity.get(key)
                       for key in ("id", "email")):
                raise StoreUnverified(f"{agent_key}: the active account does not match this store; reconcile its identity before adopting it")
        elif current.secret is None and (slot_id != "__default__" or has_managed_state):
            raise StoreUnverified(f"{agent_key}: existing account records have no matching active credential snapshot; explicit store adoption is required")
        self._db.kv_set("credential-store:" + agent_key, {
            "path": str(path), "home": str(ctx.home), "cwd": str(ctx.cwd), "env": dict(ctx.env),
        }, now=int(time.time()))
        return identity


def active_store_metadata(agent_key: str, *, exclude_term_id: str = "") -> list[dict]:
    from . import app

    result = []
    for term_id, owner in list(app._PTY_OWNERS.items()):
        if term_id == exclude_term_id:
            continue
        term = owner.terminals.get(term_id)
        if term is not None and not getattr(term, "closed", False) and term.agent_key == agent_key:
            result.append(term.metadata)
    return result


def managed_watch_path(agent_key: str) -> Path | None:
    from . import app

    try:
        return app.credential_vault._live_file(agent_key)
    except StoreUnverified:
        return None
