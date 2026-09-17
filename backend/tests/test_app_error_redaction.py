"""Messages leaving the generic dispatcher must not carry the user's home
directory. ``OSError.__str__`` embeds the filename, so an unhandled
FileNotFoundError put an absolute path into UI text -- and since 599d79bc the
accounts pane toasts whatever message it is handed, not just two known codes.
Kept portable: the expectation is "the home prefix is gone", not a literal
POSIX path.
"""

from pathlib import Path

from agent_team_backend.app import _redact_home


def test_redacts_the_home_prefix() -> None:
    path = Path.home() / ".claude" / ".credentials.json"
    redacted = _redact_home(f"[Errno 2] No such file or directory: '{path}'")

    assert str(Path.home()) not in redacted
    assert redacted.startswith("[Errno 2] No such file or directory: '~")


def test_leaves_a_message_without_a_home_path_alone() -> None:
    assert _redact_home("profile not found: p1") == "profile not found: p1"


def test_does_not_eat_a_sibling_directory_sharing_the_prefix() -> None:
    # /Users/neil is a prefix of /Users/neilson; a plain str.replace would
    # rewrite an unrelated user's path to "~son".
    sibling = f"{Path.home()}2"
    assert _redact_home(f"cannot open '{sibling}'") == f"cannot open '{sibling}'"
