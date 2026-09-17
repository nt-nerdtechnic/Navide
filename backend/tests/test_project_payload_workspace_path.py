"""The project payload names the workspace directory, not a file inside it.

The frontend resumes a pipeline run into ``project.workspace_path``. It used to
derive the workspace by stripping ``/.agent-team/project.json`` off
``paths.project_file`` — but since the SQLite migration that file is
``.agent-team/navide.db``, the strip matched nothing, and the database file
became the cwd of every pane the resumed stage spawned ("cwd does not exist:
…/.agent-team/navide.db"). These pin the two halves of the payload the fix
relies on, so neither can drift back into the other's shape.
"""

import os

from agent_team_backend import app
from agent_team_backend.db import WorkspaceDatabases
from agent_team_backend.projects import ProjectStore


def _peeked_payload(tmp_path, monkeypatch):
    store = ProjectStore()
    monkeypatch.setattr(app, "project_store", store)
    store.load_or_create(str(tmp_path))
    # peek is what the resume banner is built from after a restart.
    project = store.peek(str(tmp_path))
    assert project is not None
    return app._project_payload(project)


def test_workspace_path_is_the_workspace_directory(tmp_path, monkeypatch):
    payload = _peeked_payload(tmp_path, monkeypatch)
    workspace = payload["project"]["workspace_path"]
    assert os.path.isdir(workspace)
    assert workspace == os.path.abspath(tmp_path)


def test_project_file_is_a_file_inside_the_workspace_not_the_workspace(tmp_path, monkeypatch):
    payload = _peeked_payload(tmp_path, monkeypatch)
    project_file = payload["paths"]["project_file"]
    assert os.path.isfile(project_file)
    assert os.path.dirname(os.path.dirname(project_file)) == payload["project"]["workspace_path"]


def test_workspace_path_follows_a_moved_folder(tmp_path, monkeypatch):
    """The document stores the workspace path it was created under. A folder
    moved or renamed since must resume into where it is NOW — peek overwrites
    the stored value with the directory it was asked about. Without that, the
    tests above still pass (stored and asked-for paths coincide there)."""
    databases = WorkspaceDatabases()
    store = ProjectStore(databases)
    monkeypatch.setattr(app, "project_store", store)
    original = tmp_path / "original"
    original.mkdir()
    store.load_or_create(str(original))
    # Windows refuses to rename a directory while a file inside it is open, and
    # load_or_create leaves the workspace database open. peek reopens it.
    databases.close_all()
    moved = tmp_path / "moved"
    # Close the workspace database first: creating the project opened
    # .agent-team/navide.db inside this folder, and Windows refuses to rename a
    # directory that still holds an open handle (WinError 5), where POSIX does
    # not care. Renaming a folder out from under a running backend is not what
    # this test is about — it is about what peek() reports afterwards.
    store._databases.close_all()
    original.rename(moved)
    project = store.peek(str(moved))
    assert project is not None
    assert app._project_payload(project)["project"]["workspace_path"] == os.path.abspath(moved)
