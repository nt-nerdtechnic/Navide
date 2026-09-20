"""Placeholder — mcode ships no log reader yet.

Every registered vendor needs a module here (``test_cli_vendors_registry``
asserts this package's module set equals the registry's key set). The other
thirteen re-export a reader from their vendor module; mcode has none to
re-export, so this file is deliberately empty of exports.

mcode does keep its conversations locally, but in SQLite rather than the
JSONL-per-session layout every existing reader is built around:

    <data-dir>/v2/sqlite/runtime-state.sqlite   (WAL mode)
      local_runtime_sessions      session_id, workspace_dir, title, status,
                                  created_at_ms, record_json
      local_runtime_message_rows  session_id, msg_id, role, turn_id,
                                  created_at_ms, data_json
      local_runtime_token_usage   (token accounting, shape unexamined)

Writing the reader needs an authenticated session to model ``data_json``
against; until then, guessing its shape would hand the turn detector and the
resume preflight records that may not exist. See ``cli_vendors/mcode.py``.
"""

from __future__ import annotations

__all__: list[str] = []
