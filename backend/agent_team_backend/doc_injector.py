"""Doc injector: detects tech stack from task description,
queries Context7 via MCP, and returns a formatted prefix
ready to prepend to any stage kickoff prompt.

Three LLM enhancements over the original regex-only version:
  ① LLM generates a precise doc_query and detects the tech stack
    (regex used as fallback when LLM is unavailable or times out).
  ② Workspace summary — reads key project files, LLM produces a
    1-2 sentence context note injected before the framework docs.
  ③ Relevance selection — after Context7 returns docs for multiple
    libraries, LLM drops sections not relevant to the current task.

All LLM steps are best-effort: failures fall back to the non-LLM path.
The caller receives "" on any hard error — kickoff continues normally.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .mcp_manager import MCPManager

log = logging.getLogger("agent_team_backend.doc_injector")

# ── Regex fallback stack detection ────────────────────────────────────────────

_STACK_PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"\bwordpress\b", re.I), "WordPress"),
    (re.compile(r"\bnext\.?js\b", re.I), "Next.js"),
    (re.compile(r"\blaravel\b", re.I), "Laravel"),
    (re.compile(r"\bnuxt\b", re.I), "Nuxt"),
    (re.compile(r"\bvue(?:\.js)?\b", re.I), "Vue"),
    (re.compile(r"\breact\b", re.I), "React"),
    (re.compile(r"\bprisma\b", re.I), "Prisma"),
    (re.compile(r"\btailwind\b", re.I), "Tailwind CSS"),
    (re.compile(r"\bfastapi\b", re.I), "FastAPI"),
    (re.compile(r"\bdjango\b", re.I), "Django"),
    (re.compile(r"\bexpress(?:\.js)?\b", re.I), "Express"),
    (re.compile(r"\bsupabase\b", re.I), "Supabase"),
    (re.compile(r"\bstrapi\b", re.I), "Strapi"),
    (re.compile(r"\bsveltekit\b", re.I), "SvelteKit"),
    (re.compile(r"\bsvelte\b", re.I), "Svelte"),
    (re.compile(r"\bangular\b", re.I), "Angular"),
    (re.compile(r"\bdrizzle\b", re.I), "Drizzle ORM"),
    (re.compile(r"\bmongodb\b|mongoose", re.I), "MongoDB"),
    (re.compile(r"\bpostgresql?\b|\bpg\b", re.I), "PostgreSQL"),
]

_MAX_LIBRARIES = 2       # query at most 2 to keep latency low
_DOC_CHAR_LIMIT = 4_000  # trim raw doc to ~4 000 chars before relevance pass
_CONTEXT7_SERVER = "context7"
_JSON_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)

# Workspace files to read for summary (in priority order, with char limit each)
_WORKSPACE_FILES: list[tuple[str, int]] = [
    ("README.md", 3_000),
    ("readme.md", 3_000),
    ("CLAUDE.md", 1_500),
    ("claude.md", 1_500),
    ("package.json", 800),
    ("pyproject.toml", 800),
    ("Cargo.toml", 800),
]


def detect_stack(task: str) -> list[str]:
    """Regex fallback: return up to _MAX_LIBRARIES library names found in task."""
    found: list[str] = []
    for pattern, name in _STACK_PATTERNS:
        if pattern.search(task) and name not in found:
            found.append(name)
        if len(found) >= _MAX_LIBRARIES:
            break
    return found


# ── MCP result helpers ────────────────────────────────────────────────────────

def _extract_text(result: object) -> str:
    try:
        content = result.content  # type: ignore[attr-defined]
        if isinstance(content, list) and content:
            first = content[0]
            if hasattr(first, "text"):
                return str(first.text)
        if isinstance(content, str):
            return content
    except Exception:  # noqa: BLE001
        pass
    return str(result)


def _extract_library_id(text: str) -> str | None:
    m = re.search(r"Context7-compatible library ID:\s*(/\S+)", text)
    if m:
        return m.group(1).rstrip(",.")
    return None


def _safe_parse_json(text: str) -> dict | None:
    m = _JSON_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


# ── LLM helpers ───────────────────────────────────────────────────────────────

async def _get_gguf(model: str) -> Path | None:
    """Resolve model name → GGUF path; return None if not found."""
    try:
        from .analyzer import _find_gguf_path
        return _find_gguf_path(model)
    except Exception as err:
        log.debug("doc_injector: GGUF not found for '%s': %s", model, err)
        return None


_EOS_TOKENS = re.compile(
    r'\s*(?:\[end of text\]|<\|im_end\|>|<\|endoftext\|>)\s*$',
    re.IGNORECASE,
)


async def _llm_call(
    system: str,
    user: str,
    gguf_path: Path,
    n_predict: int = 200,
    timeout: float = 15.0,
) -> str | None:
    """Single LLM call; returns stripped text or None on failure."""
    try:
        from .analyzer import _run_llama_cli
        raw, _ = await _run_llama_cli(
            system_prompt=system,
            user_message=user,
            gguf_path=gguf_path,
            n_predict=n_predict,
            temperature=0.1,
            timeout=timeout,
        )
        cleaned = _EOS_TOKENS.sub("", raw).strip()
        return cleaned or None
    except Exception as err:
        log.debug("doc_injector LLM call failed: %s", err)
        return None


# ── Enhancement ①: LLM stack detection + doc_query ──────────────────────────

_DETECT_SYSTEM = (
    "You are a tech-stack analyzer. Analyze the task description and return JSON:\n"
    "{\"libraries\": [\"framework-name\"], \"doc_query\": \"english search string\"}\n"
    "At most 2 libraries — list only major frameworks (Vue, React, FastAPI, Django, Laravel, Express, etc.).\n"
    "doc_query should target the specific needs of the task, in English, 10-50 words.\n"
    "If there are no framework requirements, return an empty array for libraries.\n"
    "Return JSON only — no markdown, no extra text."
)


async def _llm_detect_stack(
    task: str,
    gguf_path: Path,
    timeout: float = 15.0,
) -> tuple[list[str], str] | None:
    """Enhancement ①: LLM detects stack + generates doc_query.

    Returns (libraries, doc_query) or None on failure (caller uses regex fallback).
    """
    raw = await _llm_call(_DETECT_SYSTEM, f"Task: {task}", gguf_path,
                          n_predict=128, timeout=timeout)
    if not raw:
        return None
    d = _safe_parse_json(raw)
    if not d:
        return None
    libs = [str(l).strip() for l in (d.get("libraries") or []) if str(l).strip()][:_MAX_LIBRARIES]
    query = str(d.get("doc_query") or "").strip()
    if not query:
        return None
    log.info("LLM stack detect → libraries=%s query=%r", libs, query)
    return libs, query


# ── Enhancement ②: Workspace summary ─────────────────────────────────────────

_SUMMARY_SYSTEM = (
    "You are a technical documentation summarizer. Based on the provided project files, "
    "write 1-2 sentences describing what this workspace is and its main tech stack. "
    "Output the summary directly — no headings, no extra explanation."
)


async def _llm_workspace_summary(
    workspace_path: str,
    gguf_path: Path,
    timeout: float = 15.0,
) -> str:
    """Enhancement ②: Read key workspace files → LLM 1-2 sentence summary.

    Returns summary string or "" on failure / empty workspace.
    """
    root = Path(workspace_path)
    if not root.is_dir():
        return ""

    snippets: list[str] = []
    seen_inodes: set[int] = set()  # deduplicate on case-insensitive fs (macOS)
    for fname, char_limit in _WORKSPACE_FILES:
        fpath = root / fname
        if not fpath.is_file():
            continue
        try:
            st = fpath.stat()
            if st.st_size > 5 * 1024 * 1024:  # skip files larger than 5 MB
                continue
            if st.st_ino in seen_inodes:
                continue
            seen_inodes.add(st.st_ino)
            text = fpath.read_text(encoding="utf-8", errors="replace")[:char_limit]
            snippets.append(f"[{fname}]\n{text.strip()}")
        except Exception:  # noqa: BLE001
            pass

    if not snippets:
        log.debug("workspace summary: no readable files found in %s", workspace_path)
        return ""

    # Stay well within the 4096-token context window (system + user + response)
    content = "\n\n".join(snippets)[:2_500]
    raw = await _llm_call(_SUMMARY_SYSTEM, content, gguf_path,
                          n_predict=150, timeout=timeout)
    if raw and 10 < len(raw) < 350:
        log.info("workspace summary: %d chars — %s…", len(raw), raw[:80])
        return raw
    return ""


# ── Enhancement ③: Relevance selection ───────────────────────────────────────

_RELEVANCE_SYSTEM = (
    "You are a document relevance scorer. Based on the task description, select the most relevant "
    "sections from the provided document segments.\n"
    "Return JSON: {\"keep\": [list of paragraph indices starting from 0]}\n"
    "Keep only genuinely useful sections; keep all if all are relevant; "
    "if there is only one section return {\"keep\": [0]}.\n"
    "Return JSON only — no extra text."
)


async def _llm_select_relevant(
    task: str,
    doc_parts: list[tuple[str, str]],  # [(lib_name, doc_text), ...]
    gguf_path: Path,
    timeout: float = 12.0,
) -> list[tuple[str, str]]:
    """Enhancement ③: Drop doc sections not relevant to the task.

    Returns a filtered subset of doc_parts (at least 1 item always kept).
    """
    if len(doc_parts) <= 1:
        return doc_parts

    # Build a compact summary of each part for the LLM to evaluate
    part_summaries: list[str] = []
    for i, (lib_name, doc_text) in enumerate(doc_parts):
        preview = doc_text[:500].replace("\n", " ")
        part_summaries.append(f"Section {i} [{lib_name}]: {preview}…")

    user_msg = f"Task: {task}\n\n" + "\n\n".join(part_summaries)
    raw = await _llm_call(_RELEVANCE_SYSTEM, user_msg, gguf_path,
                          n_predict=64, timeout=timeout)
    if not raw:
        return doc_parts

    d = _safe_parse_json(raw)
    if not d:
        return doc_parts

    keep_indices = d.get("keep")
    if not isinstance(keep_indices, list) or not keep_indices:
        return doc_parts

    # Validate indices and apply filter
    valid = [i for i in keep_indices if isinstance(i, int) and 0 <= i < len(doc_parts)]
    if not valid:
        return doc_parts

    filtered = [doc_parts[i] for i in sorted(set(valid))]
    dropped = [doc_parts[i][0] for i in range(len(doc_parts)) if i not in valid]
    if dropped:
        log.info("relevance filter: dropped %s (kept %s)", dropped, [p[0] for p in filtered])
    return filtered


# ── Main entry point ──────────────────────────────────────────────────────────

async def fetch_stage_docs(
    *,
    task: str,
    doc_query: str,
    mcp_manager: "MCPManager",
    workspace_path: str = "",
    analyzer_model: str = "",
    server: str = _CONTEXT7_SERVER,
) -> str:
    """Detect stack → query Context7 → return formatted doc prefix.

    Enhancements ①②③ run when an analyzer_model is provided and
    the GGUF blob exists — they degrade gracefully to the original
    regex-only path if the LLM is unavailable or times out.

    Returns "" on any hard error so the caller can safely ignore failures.
    """
    # Resolve GGUF once — shared across all three LLM enhancements
    gguf_path: Path | None = None
    if analyzer_model:
        gguf_path = await _get_gguf(analyzer_model)

    # ── Enhancement ① + workspace summary (run in parallel) ──────────────────
    async def _detect() -> tuple[list[str], str]:
        if gguf_path:
            result = await _llm_detect_stack(task, gguf_path)
            if result:
                return result
        # Fallback: regex + passed-in doc_query
        libs = detect_stack(task)
        q = doc_query.strip() or "best practices, API usage, common patterns"
        return libs, q

    async def _summarise() -> str:
        if gguf_path and workspace_path:
            return await _llm_workspace_summary(workspace_path, gguf_path)
        return ""

    (libraries, effective_query), workspace_summary = await asyncio.gather(
        _detect(), _summarise()
    )

    if not libraries:
        log.debug("No tech stack detected — skipping doc injection")
        # Still return workspace summary alone if we have one
        if workspace_summary:
            sep = "─" * 60
            return (
                f"[Workspace Context]\n{sep}\n{workspace_summary}\n{sep}\n\n"
            )
        return ""

    # ── Context7 fetch (one per library) ────────────────────────────────────
    doc_parts: list[tuple[str, str]] = []

    for lib_name in libraries:
        try:
            search_result = await mcp_manager.call_tool(
                server, "resolve-library-id",
                {"query": effective_query, "libraryName": lib_name},
            )
            search_text = _extract_text(search_result)
            library_id = _extract_library_id(search_text)
            if not library_id:
                log.debug("Context7: no library ID for '%s'", lib_name)
                continue

            doc_result = await mcp_manager.call_tool(
                server, "query-docs",
                {"libraryId": library_id, "query": effective_query},
            )
            doc_text = _extract_text(doc_result).strip()
            if not doc_text:
                continue

            if len(doc_text) > _DOC_CHAR_LIMIT:
                doc_text = doc_text[:_DOC_CHAR_LIMIT] + "\n...[truncated]"

            doc_parts.append((lib_name, doc_text))
            log.info("Context7: fetched %d chars for '%s'", len(doc_text), lib_name)

        except Exception as err:  # noqa: BLE001
            log.warning("Context7 fetch skipped for '%s': %s", lib_name, err)

    # ── Enhancement ③: relevance filtering ───────────────────────────────────
    if gguf_path and len(doc_parts) > 1:
        doc_parts = await _llm_select_relevant(task, doc_parts, gguf_path)

    # ── Assemble prefix ───────────────────────────────────────────────────────
    sep = "─" * 60
    sections: list[str] = []

    if workspace_summary:
        sections.append(f"[Workspace Context]\n{sep}\n{workspace_summary}")

    for lib_name, doc_text in doc_parts:
        sections.append(f"[{lib_name} Reference Docs — via Context7]\n{doc_text}")

    if not sections:
        return ""

    return (
        f"[Dynamic Doc Injection — LLM Enhanced]\n{sep}\n\n"
        + f"\n\n{sep}\n\n".join(sections)
        + f"\n\n{sep}\n\n"
    )
