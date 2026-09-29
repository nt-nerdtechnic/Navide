"""The visible todo row must follow plan-meta whatever order its attributes are in."""

from __future__ import annotations

import importlib.util
from pathlib import Path

ENTRY = Path(__file__).resolve().parents[2] / "plugins" / "navide-plans" / "backend" / "plans_backend.py"
_spec = importlib.util.spec_from_file_location("plans_backend_markup", ENTRY)
assert _spec and _spec.loader
plans_backend = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plans_backend)


def test_status_before_id_row_is_updated() -> None:
    html = '<li data-status="pending" data-todo-id="a"><span class="st">pending</span> A</li>'
    out = plans_backend._sync_todo_markup(html, "a", "done")
    assert 'data-status="done"' in out
    assert '<span class="st">done</span>' in out


def test_id_before_status_row_is_updated() -> None:
    html = '<li data-todo-id="a" data-status="pending"><span class="st">pending</span> A</li>'
    out = plans_backend._sync_todo_markup(html, "a", "done")
    assert 'data-status="done"' in out
    assert '<span class="st">done</span>' in out


def test_other_rows_are_untouched() -> None:
    html = (
        '<li data-todo-id="a" data-status="pending"><span class="st">pending</span></li>'
        '<li data-todo-id="b" data-status="pending"><span class="st">pending</span></li>'
    )
    out = plans_backend._sync_todo_markup(html, "a", "done")
    assert out.count('data-status="pending"') == 1
