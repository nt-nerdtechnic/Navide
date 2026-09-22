"""Two processes, two keyrings, one account, one real server: does an
unchanged credential stay readable on the other device after the account key
is rotated?

The pytest suite proves the rotation rules with both "devices" inside one
process, where the keyring is a process-wide singleton — so a test there
cannot tell a device that *received* the new ring from one that simply shares
memory with the device that made it. This script separates them: each device
is its own OS process with its own app-data directory, its own file-backed
vault and therefore its own ring, signed in to the same disposable account on
a real Navide-Server.

The ring travels between the processes through ``sync_keyring.wrap_for`` /
``accept_wrapped`` — the same sealed box the paired channel carries — written
to a file in a shared temp directory. What is *not* exercised is the pairing
channel itself (SAS, pins, ``_sync_key_peer``); that is verify_server_link's
job. This script is about the keyring lineage and the engine after the ring
arrives.

Sequence (A pastes and rotates, B receives):

  1. both: sign in; publish {deviceId, encPublicKey}
  2. A: mint the ring, push the credential, wrap the ring for B
  3. B: accept the ring, pull, read the value                       (kid 1)
  4. A: rotate; push again — the same bytes under the new key; wrap again
  5. B, still on the old ring: a round HOLDS at the resealed row (UnknownKeyId),
     the cached value is still served, nothing is pushed
  6. B: accept the new ring; a round applies the resealed row with no conflict
     and no re-push; the value is unchanged; the server body opens under the
     new key; one more round is a no-op

Usage (server must already be running; a disposable one, never production):

    NAVIDE_WS=ws://localhost:18811/ws \\
      uv --project backend run python backend/scripts/verify_rotation_two_processes.py

Registers one disposable account (RFC 2606 domain). Exit 0 only when every
check in both processes passed.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

URL = os.environ.get("NAVIDE_WS") or "ws://localhost:8787/ws"
SECRET_PREFIX = "sk-ant-oat01-ROTATE-"
AGENT, SLOT = "claude", "__default__"

_passed = 0
_failed = 0


def check(cond: bool, label: str, extra: Any = None) -> bool:
    global _passed, _failed
    role = os.environ.get("ROTATE_ROLE", "")
    tag = f"[{role}] " if role else ""
    if cond:
        _passed += 1
        print(f"  ✓ {tag}{label}", flush=True)
    else:
        _failed += 1
        detail = "" if extra is None else f"  -> {json.dumps(extra, ensure_ascii=False, default=str)}"
        print(f"  ✗ {tag}{label}{detail}", flush=True)
    return cond


# ---- file mailbox between the two processes ----------------------------------

def _put(shared: Path, name: str, payload: Any) -> None:
    tmp = shared / f"{name}.tmp"
    tmp.write_text(json.dumps(payload))
    tmp.rename(shared / f"{name}.json")


def _wait(shared: Path, name: str, timeout: float = 60.0) -> Any:
    deadline = time.monotonic() + timeout
    path = shared / f"{name}.json"
    while time.monotonic() < deadline:
        if path.exists():
            return json.loads(path.read_text())
        time.sleep(0.05)
    raise SystemExit(f"timed out waiting for {name}")


# ---- one device -----------------------------------------------------------------

async def run_device(role: str, shared: Path, token: str) -> int:
    # Everything this process touches lives in its own data dir; set before
    # importing app, which opens navide.db at module scope.
    data_dir = Path(tempfile.mkdtemp(prefix=f"navide-rotate-{role}-"))
    os.environ["AGENT_TEAM_DATA_DIR"] = str(data_dir)
    os.environ["ROTATE_ROLE"] = role

    from agent_team_backend import app, device_crypto, server_link, sync_engine, sync_keyring, sync_scopes
    from agent_team_backend.credential_vault import CredentialVault
    from agent_team_backend.db import Database
    from agent_team_backend.server_link import ServerLink, ServerLinkConfig

    app.credential_vault = CredentialVault(
        root=data_dir / "vault", real_home=data_dir / "home", platform="linux"
    )

    link = ServerLink(
        config_loader=lambda: ServerLinkConfig(url=URL, token=token),
        token_clearer=lambda: None,
        device_name=f"rotate-{role}",
    )
    if not await link.start():
        raise SystemExit("ServerLink refused to start")
    deadline = asyncio.get_running_loop().time() + 20
    while not (link.member_id or link.terminated_reason):
        if asyncio.get_running_loop().time() > deadline:
            raise SystemExit(f"{role} did not authenticate")
        await asyncio.sleep(0.05)
    if link.terminated_reason:
        raise SystemExit(f"{role} failed to authenticate: {link.terminated_reason}")
    me = link._device_id  # noqa: SLF001 - the id the server knows this connection by
    _put(shared, f"{role}.hello", {"deviceId": me, "encPublicKey": device_crypto.public_key()})
    other_role = "B" if role == "A" else "A"
    other = _wait(shared, f"{other_role}.hello")

    class Vault:
        def __init__(self, values: dict) -> None:
            self.values = dict(values)

        def entries(self):
            return sorted(self.values)

        def read_secret(self, agent_key, slot_id):
            return self.values.get((agent_key, slot_id))

        def forget(self, agent_key, slot_id):
            self.values.pop((agent_key, slot_id), None)

    secret = _wait(shared, "secret")["value"]
    vault = Vault({(AGENT, SLOT): secret} if role == "A" else {})
    db = Database(data_dir / "sync.db")
    store = sync_engine.SyncStore(db)
    adapter = sync_scopes.CredentialsScope(
        db,
        entries=vault.entries,
        read_secret=vault.read_secret,
        forget_local=vault.forget,
        accepts=lambda _a, _v: True,
    )
    engine = sync_engine.SyncEngine(
        store,
        link._request,  # noqa: SLF001
        device_id=lambda: me,
        enabled=lambda _scope: True,
        signing_key_for=lambda _device: "",
    )
    engine.register(adapter)

    async def server_row() -> dict[str, Any] | None:
        raw = await link._request("sync.pull", {"scope": "credentials", "since": 0, "limit": 200})  # noqa: SLF001
        rows = ((raw or {}).get("payload") or {}).get("items") or []
        return rows[0] if rows else None

    try:
        if role == "A":
            check(await link.ensure_sync_key(), "A minted the account ring")
            kid1 = sync_keyring.active_key_id() or ""
            result = await engine.sync("credentials")
            check(result.get("pushed") == 1, "A pushed the credential", result)
            item_id = next(iter(adapter.snapshot()))
            wire = sync_keyring.wrap_for(
                recipient_public_key=other["encPublicKey"], from_device=me, to_device=other["deviceId"]
            )
            _put(shared, "ring.1", {"wire": wire, "kid": kid1, "itemId": item_id})

            step1 = _wait(shared, "B.step1")
            check(step1.get("ok") is True, "B read the credential under key 1", step1)

            kid2 = sync_keyring.rotate_account_key()
            check(kid2 != kid1, "rotation produced a new key id", {"kid1": kid1, "kid2": kid2})
            result = await engine.sync("credentials")
            check(result.get("pushed") == 1 and result.get("conflicts") == 0, "A re-pushed the unchanged credential under key 2", result)
            row = await server_row()
            check(
                row is not None and not sync_keyring.needs_reseal(row["body"]) and row["deviceId"] == me,
                "the server body is now under key 2",
                row and {"rev": row.get("rev"), "deviceId": row.get("deviceId")},
            )
            _put(shared, "A.step2", {"kid2": kid2, "rev": row and row.get("rev")})
            wire2 = sync_keyring.wrap_for(
                recipient_public_key=other["encPublicKey"], from_device=me, to_device=other["deviceId"]
            )
            _put(shared, "ring.2", {"wire": wire2})

            step2 = _wait(shared, "B.step2", timeout=120)
            check(step2.get("ok") is True, "B converged on key 2 without a conflict", step2)
            final = await engine.sync("credentials")
            check(final.get("pushed") == 0 and final.get("conflicts") == 0, "A's round after B converged is a no-op", final)
        else:
            ring1 = _wait(shared, "ring.1")
            sync_keyring.accept_wrapped(ring1["wire"], from_device=other["deviceId"], to_device=me)
            check(sync_keyring.active_key_id() == ring1["kid"], "B adopted ring generation 1")
            result = await engine.sync("credentials")
            ok1 = (
                result.get("pulled") == 1
                and result.get("conflicts") == 0
                and adapter.imported_value(AGENT, SLOT) == secret
            )
            check(ok1, "B pulled and opened the credential", result)
            check(store.state("credentials", ring1["itemId"]).sealed_kid == ring1["kid"], "B recorded key 1 on the agreed state")
            _put(shared, "B.step1", {"ok": ok1})

            step2 = _wait(shared, "A.step2", timeout=120)
            # Still on generation 1: the resealed row names a key B does not hold.
            before = store.cursor("credentials")
            held = await engine.sync("credentials")
            row = await server_row()
            check(
                held.get("pulled") == 0 and held.get("pushed") == 0 and held.get("conflicts") == 0,
                "without the new ring the round takes nothing and pushes nothing",
                held,
            )
            check(store.cursor("credentials") < int(step2["rev"]), "the cursor stopped short of the resealed row", {"cursor": store.cursor("credentials"), "rev": step2["rev"]})
            check(adapter.imported_value(AGENT, SLOT) == secret, "the cached value is still served meanwhile")
            try:
                sync_keyring.decrypt(row["body"], scope="credentials", item_id=ring1["itemId"])
                check(False, "the resealed body must not open under generation 1")
            except sync_keyring.UnknownKeyId:
                check(True, "the resealed body raises UnknownKeyId under generation 1")

            ring2 = _wait(shared, "ring.2")
            sync_keyring.accept_wrapped(ring2["wire"], from_device=other["deviceId"], to_device=me)
            check(sync_keyring.active_key_id() == step2["kid2"], "B adopted ring generation 2 (active is A's new key)")
            ring = sync_keyring.ring() or {}
            check(ring1["kid"] in ring.get("keys", {}), "the retired key is kept for reading")
            result = await engine.sync("credentials")
            ok2 = (
                result.get("conflicts") == 0
                and result.get("pushed") == 0
                and adapter.imported_value(AGENT, SLOT) == secret
                and store.state("credentials", ring1["itemId"]).sealed_kid == step2["kid2"]
                and store.cursor("credentials") >= int(step2["rev"])
            )
            check(ok2, "with the new ring the resealed row applies: same value, no conflict, nothing pushed", result)
            opened = json.loads(sync_keyring.decrypt(row["body"], scope="credentials", item_id=ring1["itemId"]))
            check(opened.get("value") == secret, "the server body opens under generation 2 to the same payload")
            again = await engine.sync("credentials")
            check(again.get("pulled") == 0 and again.get("pushed") == 0 and again.get("conflicts") == 0, "one more round is a no-op", again)
            disk = b""
            for suffix in ("", "-journal", "-wal", "-shm"):
                p = Path(str(data_dir / "sync.db") + suffix)
                if p.exists():
                    disk += p.read_bytes()
            check(secret.encode() not in disk, "B's SQLite never holds the plaintext")
            _put(shared, "B.step2", {"ok": ok2})
    finally:
        await link.stop()
    print(f"[{role}] {_passed} passed / {_failed} failed", flush=True)
    return 1 if _failed else 0


# ---- the orchestrator -----------------------------------------------------------

async def orchestrate() -> int:
    from agent_team_backend import server_link

    run = secrets.token_hex(4)
    created = await server_link.account_request(
        URL,
        "auth.register",
        {"email": f"rotate-{run}@example.invalid", "password": f"rotate-pwd-{secrets.token_hex(8)}"},
    )
    token = str(created.get("token") or "")
    if not token:
        raise SystemExit("could not register a disposable account")
    shared = Path(tempfile.mkdtemp(prefix="navide-rotate-shared-"))
    _put(shared, "secret", {"value": f"{SECRET_PREFIX}{run}-{secrets.token_hex(8)}"})
    print(f"== rotation across two processes against {URL} ==", flush=True)
    procs = [
        await asyncio.create_subprocess_exec(
            sys.executable, __file__, "--role", role, "--shared", str(shared), "--token", token,
            env={**os.environ, "AGENT_TEAM_DATA_DIR": ""},
        )
        for role in ("A", "B")
    ]
    codes = await asyncio.wait_for(asyncio.gather(*(p.wait() for p in procs)), timeout=300)
    ok = all(c == 0 for c in codes)
    print(f"\n== result: {'all checks passed' if ok else 'FAILED'} (exit codes A={codes[0]} B={codes[1]}) ==")
    return 0 if ok else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", choices=("A", "B"))
    parser.add_argument("--shared")
    parser.add_argument("--token")
    args = parser.parse_args()
    if args.role:
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        return asyncio.run(run_device(args.role, Path(args.shared), args.token))
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.environ["AGENT_TEAM_DATA_DIR"] = tempfile.mkdtemp(prefix="navide-rotate-orch-")
    return asyncio.run(orchestrate())


if __name__ == "__main__":
    raise SystemExit(main())
