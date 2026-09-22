"""grok's resume preflight.

Was a characterization suite pinned to the community grok-cli, whose sessions
all lived in one ~/.grok/grok.db: no per-id path existed, so the preflight had
to assume every id was resumable. The official xAI CLI keeps one directory per
session under a per-cwd group, so the path can be named and the check is real.
The per-session behaviour is covered in test_grok.py; explicit UUID resumes
also feed the shared backend attribution and duplicate-PTY guard.
"""

from __future__ import annotations

from agent_team_backend import app as app_module


def test_backend_claims_uuid_resumes_but_not_titles_or_new_session_ids() -> None:
    sid = "21fdfc1b-883a-47ce-b547-e9179ba62eef"
    assert app_module._resume_id_for_agent("grok", f"grok -r {sid}") == sid
    assert app_module._resume_id_for_agent("grok", "grok") == ""
    # Non-UUID values name titles, whose real id is not known yet.
    assert app_module._resume_id_for_agent("grok", "grok -r abc") == ""
    # `-s` NAMES a new session on this CLI and must not be read as a resume.
    assert app_module._resume_id_for_agent("grok", "grok -s abc") == ""


def test_an_empty_id_is_never_resumable() -> None:
    assert app_module._session_exists("grok", "/ws", "") is False
    assert app_module._session_lookup_path("grok", "/ws", "") == ""
