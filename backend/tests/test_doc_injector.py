"""Tests for doc_injector — stack detection and helper functions.

Real Context7 MCP calls are NOT made here (no network in unit tests).
Integration with live Context7 is covered in test_mcp_integration.py.
"""

from __future__ import annotations

import pytest
from agent_team_backend.doc_injector import (
    _DOC_CHAR_LIMIT,
    _MAX_LIBRARIES,
    _extract_library_id,
    _extract_text,
    detect_stack,
)


# ── detect_stack ──────────────────────────────────────────────────────────────

class TestDetectStack:
    def test_wordpress(self):
        assert detect_stack("Build WordPress 6.x baby products site") == ["WordPress"]

    def test_nextjs_and_prisma(self):
        assert detect_stack("Next.js 14 + Prisma + PostgreSQL auth system") == ["Next.js", "Prisma"]

    def test_laravel_and_vue(self):
        assert detect_stack("Laravel 11 + Vue 3 + Tailwind CSS") == ["Laravel", "Vue"]

    def test_vue_js_full_name(self):
        assert "Vue" in detect_stack("Vue.js SPA application")

    def test_django(self):
        assert detect_stack("Pure Python Django REST API") == ["Django"]

    def test_react_and_express(self):
        assert detect_stack("React + Express + MongoDB SaaS app") == ["React", "Express"]

    def test_vuejs_and_fastapi(self):
        assert detect_stack("Vue.js SPA + FastAPI backend") == ["Vue", "FastAPI"]

    def test_no_match_returns_empty(self):
        assert detect_stack("No recognisable tech stack here") == []

    def test_empty_task(self):
        assert detect_stack("") == []

    def test_case_insensitive(self):
        assert detect_stack("WORDPRESS site with NEXTJS") == ["WordPress", "Next.js"]

    def test_max_libraries_cap(self):
        # Even if many frameworks are mentioned, result is capped at _MAX_LIBRARIES
        task = "React + Vue + Laravel + Django + WordPress"
        result = detect_stack(task)
        assert len(result) <= _MAX_LIBRARIES

    def test_nuxt(self):
        assert "Nuxt" in detect_stack("Nuxt 3 project")

    def test_tailwind(self):
        assert "Tailwind CSS" in detect_stack("Tailwind CSS styling")

    def test_supabase(self):
        assert "Supabase" in detect_stack("Supabase + React project")

    def test_sveltekit(self):
        # SvelteKit should match before Svelte
        result = detect_stack("SvelteKit e-commerce application")
        assert "SvelteKit" in result

    def test_mongodb(self):
        assert "MongoDB" in detect_stack("MongoDB database")

    def test_mongoose_alias(self):
        assert "MongoDB" in detect_stack("mongoose ORM models")

    def test_duplicate_not_added(self):
        result = detect_stack("WordPress WordPress WordPress")
        assert result.count("WordPress") == 1


# ── _extract_library_id ───────────────────────────────────────────────────────

class TestExtractLibraryId:
    def test_standard_format(self):
        text = (
            "Available Libraries:\n"
            "- Title: WordPress\n"
            "- Context7-compatible library ID: /websites/wordpress\n"
            "- Description: WordPress CMS\n"
        )
        assert _extract_library_id(text) == "/websites/wordpress"

    def test_nextjs_id(self):
        text = "- Context7-compatible library ID: /vercel/next.js"
        assert _extract_library_id(text) == "/vercel/next.js"

    def test_id_with_version(self):
        text = "- Context7-compatible library ID: /vercel/next.js/v14.3.0"
        assert _extract_library_id(text) == "/vercel/next.js/v14.3.0"

    def test_no_id_returns_none(self):
        assert _extract_library_id("No library found here") is None

    def test_empty_string(self):
        assert _extract_library_id("") is None

    def test_trailing_punctuation_stripped(self):
        text = "- Context7-compatible library ID: /org/project,"
        lid = _extract_library_id(text)
        assert lid is not None
        assert not lid.endswith(",")


# ── _extract_text ─────────────────────────────────────────────────────────────

class TestExtractText:
    def test_mcp_result_with_content_list(self):
        class FakeContent:
            text = "hello world"

        class FakeResult:
            content = [FakeContent()]

        assert _extract_text(FakeResult()) == "hello world"

    def test_mcp_result_with_string_content(self):
        class FakeResult:
            content = "plain string"

        assert _extract_text(FakeResult()) == "plain string"

    def test_fallback_to_str(self):
        assert _extract_text("raw string") == "raw string"

    def test_none_content_falls_back(self):
        class FakeResult:
            content = None

        # Should not raise; falls through to str()
        result = _extract_text(FakeResult())
        assert isinstance(result, str)


# ── doc_char_limit constant ───────────────────────────────────────────────────

def test_doc_char_limit_reasonable():
    """Ensure the limit is within a sensible range to avoid bloating kickoffs."""
    assert 1_000 <= _DOC_CHAR_LIMIT <= 10_000


def test_max_libraries_is_two():
    """Hardcoded to 2 to keep latency acceptable."""
    assert _MAX_LIBRARIES == 2
