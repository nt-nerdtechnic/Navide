"""Bundle v1 — handing Prompts, MCP, Skills and Memory to another person.

Sync (``sync_engine``) keeps one person's own devices identical. A bundle is
the other shape of the same data: a document one person builds once, on
purpose, and gives to someone else. So this module reads through the same four
scope adapters (``sync_scopes``) instead of growing a second opinion about
where a prompt or a skill lives, and adds the two things giving needs that
syncing does not:

* **Nothing secret travels.** A synced body is sealed for an account that owns
  both ends; a bundle has no envelope and no owner, so every MCP ``env`` and
  ``headers`` value is stripped by construction rather than by guessing at the
  key name. The key names survive — the far side has to know what to fill in —
  and ``redactions`` says exactly what was taken out.
* **Only what is ours to give.** A managed skill carries its files; a skill the
  user wrote or a CLI installed is listed as ineligible with a reason and never
  packed. Project-scope instruction files are excluded for the reason sync
  excludes them: they are repository content and git is their source of truth.

Importing writes through those same adapters and stores, so the optimistic
locks and the temp-and-rename that protect an ordinary save protect an import
too. ``preview`` answers the same questions without touching disk.

The older ``settings.bundle.*`` pair (roles, pipelines, analyzer, ai_chat) is a
different document for a different job; the two never mix.
"""

from __future__ import annotations

import copy
import json
import logging
import platform
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable

from . import __version__, sync_scopes
from .skills_store import SKILL_FILE

log = logging.getLogger("agent_team_backend.settings_bundle")

BUNDLE_VERSION = 1

#: The sections a bundle can carry. The same four names as
#: ``sync_engine.SCOPES``, and deliberately not imported from it: a scope the
#: sync protocol gains later is not automatically a scope people may hand out.
SCOPES: tuple[str, ...] = ("prompts", "mcp", "skills", "memory")

#: Cap on the serialized document. A bundle is moved by hand — mail, chat, a
#: file — and something larger than this is a mistake (a skill full of build
#: output, an instruction file with a log pasted in) rather than a share.
MAX_BUNDLE_BYTES = 8 * 1024 * 1024

#: Server fields whose *values* are secrets whatever they happen to be called.
SECRET_FIELDS: tuple[str, ...] = ("env", "headers")

CREATE = "create"
OVERWRITE = "overwrite"
SKIP = "skip"


class BundleError(Exception):
    """A bundle could not be built or read. Carries a code for the wire."""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# ── what this machine can give ───────────────────────────────────────────────
@dataclass(frozen=True)
class Candidate:
    """One shareable item, as the picker sees it and as the bundle stores it."""

    scope: str
    item_id: str
    label: str
    #: The bundle-shaped payload, or None when this item cannot be packed.
    payload: dict[str, Any] | None = None
    #: Field paths whose values were stripped on the way in.
    redacted: tuple[str, ...] = ()
    eligible: bool = True
    reason: str = ""

    @property
    def size(self) -> int:
        return _json_size(self.payload) if self.payload is not None else 0

    def as_inventory(self) -> dict[str, Any]:
        return {
            "id": self.item_id,
            "label": self.label,
            "size": self.size,
            "hasSecrets": bool(self.redacted),
            "eligible": self.eligible,
            "reason": self.reason,
        }


def inventory() -> dict[str, list[dict[str, Any]]]:
    """Every item of every scope, eligible or not, with the reason why not."""
    return {scope: [c.as_inventory() for c in cands] for scope, cands in _catalogue().items()}


def _catalogue() -> dict[str, list[Candidate]]:
    return {
        "prompts": _collect_prompts(),
        "mcp": _collect_mcp(),
        "skills": _collect_skills(),
        "memory": _collect_memory(),
    }


def _collect_prompts() -> list[Candidate]:
    out: list[Candidate] = []
    for item_id, raw in sorted(sync_scopes.PromptsScope().snapshot().items()):
        if not isinstance(raw, dict):
            continue
        # isDefault is a property of *this* list, not of the skill: carrying it
        # would give the receiving machine two defaults, which the renderer
        # resolves by picking one arbitrarily.
        payload = {key: value for key, value in raw.items() if key != "isDefault"}
        out.append(
            Candidate(
                scope="prompts",
                item_id=item_id,
                label=str(raw.get("name") or item_id),
                payload=payload,
            )
        )
    return out


def _collect_mcp() -> list[Candidate]:
    out: list[Candidate] = []
    for name, raw in sorted(sync_scopes.McpScope().snapshot().items()):
        if not isinstance(raw, dict):
            continue
        payload, redacted = strip_secrets(raw)
        out.append(
            Candidate(
                scope="mcp",
                item_id=name,
                label=name,
                payload=payload,
                redacted=redacted,
            )
        )
    return out


def _collect_skills() -> list[Candidate]:
    facts = _skill_facts()
    out: list[Candidate] = []
    for name, entry in sorted(sync_scopes.SkillsStateScope().snapshot().items()):
        content = entry.get("content") if isinstance(entry, dict) else None
        if isinstance(content, dict) and content:
            # The adapter only ever puts content here for a skill carrying the
            # .navide marker, so eligibility is decided by the store, not here.
            out.append(
                Candidate(
                    scope="skills",
                    item_id=name,
                    label=name,
                    payload={"files": content},
                )
            )
            continue
        fact = facts.get(name)
        if fact is None:
            reason = "this skill is not installed on this machine"
        elif not fact.get("managed"):
            reason = "not a skill Navide manages, so its files are not ours to share"
        else:
            reason = "its files could not be packed (too large, or no SKILL.md)"
        out.append(
            Candidate(scope="skills", item_id=name, label=name, eligible=False, reason=reason)
        )
    return out


def _collect_memory() -> list[Candidate]:
    out: list[Candidate] = []
    # MemoryScope lists user-scope files only; project-scope instruction files
    # never reach this loop.
    for relative, entry in sorted(sync_scopes.MemoryScope().snapshot().items()):
        text = entry.get("text") if isinstance(entry, dict) else None
        if not isinstance(text, str):
            continue
        out.append(
            Candidate(
                scope="memory",
                item_id=relative,
                label=relative,
                payload={"text": text},
            )
        )
    return out


def _skill_facts() -> dict[str, dict[str, Any]]:
    """What the library knows about each installed skill, by name."""
    from . import app

    try:
        listing = app.skills_store.list_skills()
    except Exception as err:  # noqa: BLE001 - an unreadable library shares nothing
        log.warning("the skills library could not be read: %s", err)
        return {}
    return {
        str(skill["name"]): skill
        for skill in listing.get("skills", [])
        if isinstance(skill, dict) and isinstance(skill.get("name"), str)
    }


def strip_secrets(server: dict[str, Any]) -> tuple[dict[str, Any], tuple[str, ...]]:
    """A server record with every env/header value emptied, and what was taken.

    Every value, not the secret-looking ones: ``redact_mcp_server_secrets``
    guesses from the key name because it is showing the user their own record
    back, where a wrong guess costs nothing. Here a wrong guess is a token in
    someone else's inbox.
    """
    record = copy.deepcopy(server)
    redacted: list[str] = []
    for field_name in SECRET_FIELDS:
        values = record.get(field_name)
        if not isinstance(values, dict):
            continue
        for key in list(values):
            if isinstance(values[key], str) and values[key]:
                redacted.append(f"{field_name}.{key}")
            values[key] = ""
    return record, tuple(redacted)


# ── export ───────────────────────────────────────────────────────────────────
def export_bundle(
    selection: dict[str, Any],
    *,
    name: str = "",
    description: str = "",
) -> dict[str, Any]:
    """Build the document for ``selection`` — ``{scope: [item ids]}``."""
    catalogue = {scope: {c.item_id: c for c in cands} for scope, cands in _catalogue().items()}
    scopes: dict[str, Any] = {}
    redactions: list[dict[str, Any]] = []
    for scope in SCOPES:
        items: dict[str, Any] = {}
        for item_id in selected_ids(selection, scope):
            candidate = catalogue[scope].get(item_id)
            if candidate is None:
                raise BundleError(
                    "ITEM_NOT_FOUND",
                    f"{scope}: there is nothing here called {item_id!r}",
                    {"scope": scope, "item": item_id},
                )
            if not candidate.eligible or candidate.payload is None:
                raise BundleError(
                    "ITEM_NOT_ELIGIBLE",
                    f"{scope}: {item_id!r} cannot be shared — {candidate.reason}",
                    {"scope": scope, "item": item_id, "reason": candidate.reason},
                )
            items[item_id] = candidate.payload
            if candidate.redacted:
                redactions.append(
                    {"scope": scope, "item": item_id, "fields": list(candidate.redacted)}
                )
        scopes[scope] = {"items": items}
    bundle = {
        "bundleVersion": BUNDLE_VERSION,
        "name": str(name or ""),
        "description": str(description or ""),
        "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "createdBy": {"device": platform.node() or "", "app": f"Navide {__version__}"},
        "scopes": scopes,
        "redactions": redactions,
    }
    ensure_within_limit(bundle)
    return bundle


def ensure_within_limit(bundle: dict[str, Any]) -> int:
    """The serialized size, or ``BundleError`` naming the scope that burst it."""
    total = _json_size(bundle)
    if total <= MAX_BUNDLE_BYTES:
        return total
    scopes = bundle.get("scopes") if isinstance(bundle.get("scopes"), dict) else {}
    sizes = {scope: _json_size(scopes.get(scope)) for scope in SCOPES}
    worst = max(sizes, key=lambda scope: sizes[scope])
    raise BundleError(
        "BUNDLE_TOO_LARGE",
        f"the bundle is {total} bytes and the limit is {MAX_BUNDLE_BYTES}; "
        f"{worst} is the largest part of it at {sizes[worst]} bytes",
        {"total": total, "limit": MAX_BUNDLE_BYTES, "scope": worst, "scopes": sizes},
    )


def selected_ids(selection: Any, scope: str) -> list[str]:
    if not isinstance(selection, dict):
        return []
    ids = selection.get(scope)
    if not isinstance(ids, list):
        return []
    return [item for item in ids if isinstance(item, str) and item]


# ── import ───────────────────────────────────────────────────────────────────
def read_bundle(raw: Any) -> dict[str, dict[str, Any]]:
    """The four item maps a bundle carries, or ``BundleError``."""
    if not isinstance(raw, dict):
        raise BundleError("INVALID_BUNDLE", "a bundle must be an object")
    version = raw.get("bundleVersion")
    if version != BUNDLE_VERSION:
        raise BundleError(
            "UNSUPPORTED_BUNDLE_VERSION",
            f"bundleVersion {version!r} is not supported by this build",
            {"expected": BUNDLE_VERSION, "found": version},
        )
    # A document too large to have been exported is too large to accept: the
    # cap has to hold on the way in too, or it only constrains our own UI.
    ensure_within_limit(raw)
    scopes = raw.get("scopes")
    if not isinstance(scopes, dict):
        raise BundleError("INVALID_BUNDLE", "the bundle carries no scopes")
    parsed: dict[str, dict[str, Any]] = {}
    for scope in SCOPES:
        section = scopes.get(scope)
        items = section.get("items") if isinstance(section, dict) else None
        parsed[scope] = (
            {str(key): value for key, value in items.items()} if isinstance(items, dict) else {}
        )
    return parsed


def preview_import(raw: Any) -> list[dict[str, Any]]:
    """What importing would do, item by item. Writes nothing."""
    parsed = read_bundle(raw)
    rows: list[dict[str, Any]] = []
    for scope in SCOPES:
        if not parsed[scope]:
            continue
        local = _local_state(scope)
        for item_id, payload in parsed[scope].items():
            action, reason = _plan_item(scope, item_id, payload, local)
            rows.append({"scope": scope, "id": item_id, "action": action, "reason": reason})
    return rows


def _local_state(scope: str) -> dict[str, Any]:
    """Whatever ``_plan_item`` needs to judge this scope. Read-only."""
    if scope == "prompts":
        return sync_scopes.PromptsScope().snapshot()
    if scope == "mcp":
        return sync_scopes.McpScope().snapshot()
    if scope == "skills":
        return _skill_facts()
    return sync_scopes.MemoryScope().snapshot()


def _plan_item(
    scope: str, item_id: str, payload: Any, local: dict[str, Any]
) -> tuple[str, str]:
    if scope == "prompts":
        if not isinstance(payload, dict):
            return SKIP, "the item is not an object"
        return (OVERWRITE if item_id in local else CREATE), ""
    if scope == "mcp":
        if not isinstance(payload, dict):
            return SKIP, "the item is not an object"
        blanks = _blank_secret_fields(payload)
        reason = ""
        if blanks:
            reason = (
                f"{len(blanks)} value(s) were left out of the bundle and "
                f"must be filled in here: {', '.join(blanks)}"
            )
        return (OVERWRITE if item_id in local else CREATE), reason
    if scope == "skills":
        files = payload.get("files") if isinstance(payload, dict) else None
        if not isinstance(files, dict) or SKILL_FILE not in files:
            return SKIP, f"the bundle carries no {SKILL_FILE} for this skill"
        fact = local.get(item_id)
        if fact is None:
            return CREATE, ""
        if not fact.get("managed"):
            return SKIP, "a skill of this name is already here and is not managed by Navide"
        if fact.get("native_conflict"):
            return SKIP, "a CLI already keeps a native skill of this name"
        return OVERWRITE, ""
    if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
        return SKIP, "the item carries no text"
    # The item id is a path relative to home, so the same file is the same item
    # on a machine whose home is elsewhere — but only if this machine keeps an
    # instruction file there at all.
    if sync_scopes.MemoryScope._resolve(item_id) is None:
        return SKIP, "no instruction file on this machine sits at that path"
    return (OVERWRITE if item_id in local else CREATE), ""


def _blank_secret_fields(server: dict[str, Any]) -> list[str]:
    blanks: list[str] = []
    for field_name in SECRET_FIELDS:
        values = server.get(field_name)
        if not isinstance(values, dict):
            continue
        blanks.extend(f"{field_name}.{key}" for key, value in values.items() if value == "")
    return blanks


def apply_import(raw: Any, selection: Any) -> dict[str, Any]:
    """Write the selected items in. Blocking: call it off the event loop.

    Returns the per-item results plus what the caller has to tell the rest of
    the app about — the settings deltas other windows converge on, and whether
    the MCP manager needs to reload.
    """
    parsed = read_bundle(raw)
    deltas: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    mcp_changed = False
    for scope in SCOPES:
        chosen = set(selected_ids(selection, scope))
        items = {key: value for key, value in parsed[scope].items() if key in chosen}
        if not items:
            continue
        if scope == "prompts":
            results.extend(_apply_prompts(items, deltas))
        elif scope == "mcp":
            rows = _apply_mcp(items)
            mcp_changed = mcp_changed or any(row["ok"] and row["action"] != SKIP for row in rows)
            results.extend(rows)
        elif scope == "skills":
            results.extend(_apply_skills(items))
        else:
            results.extend(_apply_memory(items))
    return {"results": results, "settings_deltas": deltas, "mcp_changed": mcp_changed}


@dataclass
class _Run:
    """Rows written so far, and what each one expected to leave behind."""

    rows: list[dict[str, Any]] = field(default_factory=list)
    expected: dict[str, Any] = field(default_factory=dict)

    def skipped(self, scope: str, item_id: str, reason: str) -> None:
        self.rows.append(
            {"scope": scope, "id": item_id, "action": SKIP, "ok": True, "reason": reason}
        )

    def wrote(self, scope: str, item_id: str, action: str, reason: str, expect: Any) -> None:
        self.rows.append(
            {"scope": scope, "id": item_id, "action": action, "ok": True, "reason": reason}
        )
        self.expected[item_id] = expect

    def failed(self, scope: str, item_id: str, action: str, reason: str) -> None:
        self.rows.append(
            {"scope": scope, "id": item_id, "action": action, "ok": False, "reason": reason}
        )

    def verify(self, landed: Callable[[str, Any], bool]) -> list[dict[str, Any]]:
        """Re-read what was written and demote any row that did not take.

        The adapters log a refused write and carry on — right for a background
        sync round, wrong for a person who just pressed Import and is owed an
        answer. This is where "we called apply" becomes "it is on disk".
        """
        for row in self.rows:
            if not row["ok"] or row["action"] == SKIP:
                continue
            if not landed(row["id"], self.expected.get(row["id"])):
                row["ok"] = False
                row["reason"] = "the write was refused; see the backend log"
        return self.rows


def _apply_prompts(items: dict[str, Any], deltas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    before = sync_scopes.PromptsScope().snapshot()
    adapter = sync_scopes.PromptsScope(broadcast=deltas.append)
    run = _Run()
    for item_id, payload in items.items():
        action, reason = _plan_item("prompts", item_id, payload, before)
        if action == SKIP:
            run.skipped("prompts", item_id, reason)
            continue
        # isDefault is stripped again on the way in: a hand-edited bundle must
        # not be able to demote the default this machine already has.
        body = {key: value for key, value in payload.items() if key != "isDefault"}
        body["id"] = item_id
        try:
            adapter.apply(item_id, body)
        except Exception as err:  # noqa: BLE001 - one bad item is not the import
            log.warning("prompt %s was not imported: %s", item_id, err)
            run.failed("prompts", item_id, action, str(err))
            continue
        run.wrote("prompts", item_id, action, reason, body)

    after = sync_scopes.PromptsScope().snapshot()

    def landed(item_id: str, expect: Any) -> bool:
        stored = after.get(item_id)
        if not isinstance(stored, dict) or not isinstance(expect, dict):
            return False
        return {k: v for k, v in stored.items() if k != "isDefault"} == expect

    return run.verify(landed)


def _apply_mcp(items: dict[str, Any]) -> list[dict[str, Any]]:
    adapter = sync_scopes.McpScope()
    before = adapter.snapshot()
    run = _Run()
    for name, payload in items.items():
        action, reason = _plan_item("mcp", name, payload, before)
        if action == SKIP:
            run.skipped("mcp", name, reason)
            continue
        record = restore_secrets(payload, before.get(name))
        record["name"] = name
        try:
            adapter.apply(name, record)
        except Exception as err:  # noqa: BLE001 - one bad record is not the import
            log.warning("MCP server %s was not imported: %s", name, err)
            run.failed("mcp", name, action, str(err))
            continue
        run.wrote("mcp", name, action, reason, record)

    after = adapter.snapshot()

    def landed(name: str, expect: Any) -> bool:
        stored = after.get(name)
        if not isinstance(stored, dict) or not isinstance(expect, dict):
            return False
        # Secret fields are compared by key, not by value: what is on disk now
        # is this machine's own value where it had one.
        return all(
            set(stored.get(key, {})) == set(value)
            if key in SECRET_FIELDS and isinstance(value, dict)
            else stored.get(key) == value
            for key, value in expect.items()
        )

    return run.verify(landed)


def restore_secrets(incoming: dict[str, Any], existing: Any) -> dict[str, Any]:
    """Fill the blanks a bundle left with what this machine already had.

    A key with nothing local stays present and empty rather than being dropped:
    an unset variable the user can see is the prompt to go and paste their own
    token in, while a missing one is a server that fails later for no visible
    reason.
    """
    record = copy.deepcopy(incoming)
    for field_name in SECRET_FIELDS:
        values = record.get(field_name)
        if not isinstance(values, dict):
            continue
        have = existing.get(field_name) if isinstance(existing, dict) else None
        have = have if isinstance(have, dict) else {}
        for key, value in values.items():
            if value == "" and isinstance(have.get(key), str) and have[key]:
                values[key] = have[key]
    return record


def _apply_skills(items: dict[str, Any]) -> list[dict[str, Any]]:
    from . import app

    facts = _skill_facts()
    rows: list[dict[str, Any]] = []
    for name, payload in items.items():
        action, reason = _plan_item("skills", name, payload, facts)
        if action == SKIP:
            rows.append({"scope": "skills", "id": name, "action": SKIP, "ok": True, "reason": reason})
            continue
        # import_content is the adapter's own write path: it refuses to displace
        # a skill that is not ours and stages into a temp dir before renaming.
        try:
            landed = bool(app.skills_store.import_content(name, payload["files"]))
        except Exception as err:  # noqa: BLE001 - one refused skill is not the import
            log.warning("skill %s was not imported: %s", name, err)
            rows.append(
                {"scope": "skills", "id": name, "action": action, "ok": False, "reason": str(err)}
            )
            continue
        rows.append(
            {
                "scope": "skills",
                "id": name,
                "action": action,
                "ok": landed,
                "reason": reason if landed else "the skills library refused it; see the backend log",
            }
        )
    return rows


def _apply_memory(items: dict[str, Any]) -> list[dict[str, Any]]:
    adapter = sync_scopes.MemoryScope()
    before = adapter.snapshot()
    run = _Run()
    for relative, payload in items.items():
        action, reason = _plan_item("memory", relative, payload, before)
        if action == SKIP:
            run.skipped("memory", relative, reason)
            continue
        try:
            adapter.apply(relative, {"text": payload["text"]})
        except Exception as err:  # noqa: BLE001 - one unwritable file is not the import
            log.warning("instruction file %s was not imported: %s", relative, err)
            run.failed("memory", relative, action, str(err))
            continue
        run.wrote("memory", relative, action, reason, payload["text"])

    after = adapter.snapshot()

    def landed(relative: str, expect: Any) -> bool:
        stored = after.get(relative)
        return isinstance(stored, dict) and stored.get("text") == expect

    return run.verify(landed)


def _json_size(value: Any) -> int:
    try:
        encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return 0
    return len(encoded.encode("utf-8"))
