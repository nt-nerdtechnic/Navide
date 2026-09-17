"""terminals.create names what is actually wrong with a bad cwd.

A resumed pipeline once spawned into its own `.agent-team/navide.db` and was
told the file "does not exist" — true of no directory, false of the path,
which pointed straight at the wrong diagnosis. A path that exists as a file is
a different mistake from one that is missing.
"""

import pytest

from agent_team_backend.terminals import TerminalService


async def _noop_emit(_event):
    return None


async def test_a_file_is_reported_as_not_a_directory(tmp_path):
    db = tmp_path / ".agent-team" / "navide.db"
    db.parent.mkdir()
    db.write_text("")
    with pytest.raises(FileNotFoundError, match=r"^cwd is not a directory: .*navide\.db$"):
        TerminalService(_noop_emit).create(pane_id="p1", agent_key=None, command=["/bin/sh"], cwd=str(db))


async def test_a_missing_path_is_still_reported_as_missing(tmp_path):
    missing = tmp_path / "gone"
    with pytest.raises(FileNotFoundError, match=r"^cwd does not exist: .*gone$"):
        TerminalService(_noop_emit).create(pane_id="p1", agent_key=None, command=["/bin/sh"], cwd=str(missing))
