"""Invocation-scoped Codex SessionStart identity, with log verification.

The command is stable across launches: per-process identity lives in the
spawn environment, not the hook definition that Codex asks the user to trust.
No user config is written and no hook-trust bypass is requested.
"""
from __future__ import annotations

import base64
import json
import re
import secrets
import threading
from pathlib import Path
from typing import Any

from . import osplat
from .cli_vendors.codex import is_subagent_session_meta

LAUNCH_ENV = 'NAVIDE_CODEX_LAUNCH'
LAUNCH_HEADER = 'X-Navide-Codex-Launch'
_UUID = re.compile(r'^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$')


def resume_identity(value: str) -> str:
    """Only an explicit UUID is a known identity; names/--last are selectors."""
    return value if _UUID.fullmatch(value) else ''


def hook_command() -> str:
    if osplat.platform_id == 'windows':
        script = '''[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not $env:NAVIDE_CODEX_LAUNCH) { exit 0 }; try {
$navidePort = Get-Content -ErrorAction Stop $env:NAVIDE_CODEX_PORT_FILE
$body = [Console]::In.ReadToEnd()
$body | curl.exe -fsS -m 2 -o NUL -X POST -H 'Content-Type: application/json' -H ("@" + $env:NAVIDE_CODEX_AUTH_FILE) -H ("X-Navide-Codex-Launch: " + $env:NAVIDE_CODEX_LAUNCH) --data-binary '@-' ("http://127.0.0.1:" + $navidePort + "/hooks/codex/session-start")
} catch {}; exit 0'''
        return 'powershell.exe -NoProfile -NonInteractive -EncodedCommand ' + base64.b64encode(script.encode('utf-16-le')).decode()
    return (
        '[ -n "$NAVIDE_CODEX_LAUNCH" ] || exit 0; '
        'navide_port=$(cat "$NAVIDE_CODEX_PORT_FILE" 2>/dev/null); '
        '[ -n "$navide_port" ] || exit 0; '
        'curl -fsS -m 2 -o /dev/null -X POST '
        '-H "Content-Type: application/json" '
        '-H "@$NAVIDE_CODEX_AUTH_FILE" '
        '-H "X-Navide-Codex-Launch: $NAVIDE_CODEX_LAUNCH" '
        '--data-binary @- "http://127.0.0.1:$navide_port/hooks/codex/session-start" '
        '2>/dev/null || true'
    )


def wire(command: Any, env: dict, metadata: dict, home: Path, port_file: Path, auth_file: Path) -> Any:
    """Append a session-layer hook; Codex appends lower-layer user hooks too."""
    text = str(command[-1]) if isinstance(command, list) and command else str(command or '')
    # A custom session-layer SessionStart override belongs to the user. Adding
    # the same override twice would replace that layer's array, so leave it.
    if re.search(r"(?:^|\s)(?:-c(?:=|\s*)|--config(?:=|\s+))[\"']?hooks(?:[.=\s]|$)", text):
        return command
    nonce = secrets.token_urlsafe(32)
    metadata['codex_launch_token'] = nonce
    metadata['codex_session_home'] = str(home)
    if metadata.get('explicit_session_id'):
        metadata['codex_current_session_id'] = metadata['explicit_session_id']
    env.update({LAUNCH_ENV: nonce, 'NAVIDE_CODEX_PORT_FILE': str(port_file), 'NAVIDE_CODEX_AUTH_FILE': str(auth_file)})
    definition = 'hooks.SessionStart=[{matcher="^(startup|resume)$",hooks=[{type="command",command=' + json.dumps(hook_command()) + ',timeout=3}]}]'
    text += ' -c ' + osplat.paths.quote_arg(definition)
    return [*command[:-1], text] if isinstance(command, list) else text


class PendingStarts:
    """A callback may precede both attribution registration and rollout flush."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._pending: dict[tuple[str, str], dict] = {}
        self._consumed: set[tuple[str, str]] = set()
        self._current: dict[str, str] = {}

    def add(self, token: str, payload: dict) -> bool:
        sid = resume_identity(str(payload.get('session_id') or ''))
        if payload.get('hook_event_name') != 'SessionStart':
            return False
        if not isinstance(payload.get('cwd'), str) or not payload['cwd']:
            return False
        if payload.get('transcript_path') is not None and not isinstance(payload['transcript_path'], str):
            return False
        if not token or not sid or payload.get('source') not in ('startup', 'resume'):
            return False
        with self._lock:
            if (token, sid) in self._consumed:
                return False
            current = self._current.get(token)
            if current and current != sid:
                return False
            self._current[token] = sid
            self._pending[(token, sid)] = dict(payload)
        return True

    def has_pending(self, token: str = "") -> bool:
        with self._lock:
            return any(not token or t == token for t, _ in self._pending)

    def paths(self, token: str) -> list[Path]:
        with self._lock:
            return [Path(p['transcript_path']) for (t, _), p in self._pending.items()
                    if t == token and isinstance(p.get('transcript_path'), str) and p['transcript_path']]

    def find_paths(self, token: str, home: Path) -> list[Path]:
        with self._lock:
            ids = [sid for t, sid in self._pending if t == token]
        return [p for sid in ids for p in (home / 'sessions').rglob(f'rollout-*{sid}.jsonl')]

    def match(self, path: Path, live: dict[str, tuple[str, str]]) -> tuple[str, str, str] | None:
        with self._lock:
            # Drop old processes before any read: delayed hooks cannot revive
            # a pane after a respawn, even when its UI id stays unchanged.
            self._pending = {k: v for k, v in self._pending.items() if k[0] in live}
            self._consumed = {k for k in self._consumed if k[0] in live}
            self._current = {k: v for k, v in self._current.items() if k in live}
            pending = dict(self._pending)
        if not pending:
            return None
        try:
            with path.open(encoding='utf-8') as f:
                first = json.loads(f.readline(524_288))
        except (OSError, ValueError):
            return None
        meta = first.get('payload') if isinstance(first, dict) and first.get('type') == 'session_meta' else None
        if not isinstance(meta, dict) or is_subagent_session_meta(meta):
            return None
        sid = str(meta.get('id') or '')
        for (token, expected), payload in pending.items():
            if expected != sid:
                continue
            pane, cwd = live[token]
            if Path(str(meta.get('cwd') or '')).resolve() != Path(cwd).resolve():
                continue
            if payload.get('cwd') and Path(payload['cwd']).resolve() != Path(cwd).resolve():
                continue
            declared = payload.get('transcript_path')
            if declared and Path(declared).resolve() != path.resolve():
                continue
            return token, pane, sid
        return None

    def consume(self, token: str, sid: str) -> None:
        with self._lock:
            self._pending.pop((token, sid), None)
            self._consumed.add((token, sid))
            self._current[token] = sid
