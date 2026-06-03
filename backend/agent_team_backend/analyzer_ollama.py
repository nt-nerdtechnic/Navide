"""Ollama REST API backend for the analyzer.

Implements the same public interface as analyzer.py (health, list_models,
classify, auto_answer, benchmark) plus model management (pull_model,
delete_model) that is only meaningful with a running Ollama server.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Any, AsyncIterator

import httpx

from .analyzer import (
    DEFAULT_MODEL,
    MAX_INPUT_CHARS,
    SYSTEM_PROMPT,
    _AUTO_ANSWER_SYSTEM_PROMPT,
    _BENCHMARK_TASKS,
    _SKIP_FAMILIES,
    _apply_choice_heuristics,
    _check_task,
    _clean_for_analysis,
    _safe_parse_json,
)

log = logging.getLogger("agent_team_backend.analyzer_ollama")

_JSON_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)
_FILLER_PROMPTS = {"無", "无", "n/a", "na", "none", "null", "－", "-", "—", ""}
_PLACEHOLDER_RE = re.compile(r"^<[^>]+>$")


# ─── HTTP helpers ─────────────────────────────────────────────────────────────

def _client(base_url: str, timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url.rstrip("/"), timeout=timeout)


async def _generate(
    base_url: str,
    model: str,
    system: str,
    prompt: str,
    n_predict: int = 512,
    temperature: float = 0.1,
    timeout: float = 60.0,
) -> tuple[str, dict]:
    """POST /api/generate → (response_text, perf_stats)."""
    payload = {
        "model": model,
        "system": system,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": temperature, "num_predict": n_predict},
    }
    async with _client(base_url, timeout) as c:
        r = await c.post("/api/generate", json=payload)
        r.raise_for_status()
        data = r.json()
    text = data.get("response", "").strip()
    stats = {
        "prompt_eval_count": data.get("prompt_eval_count", 0),
        "eval_count": data.get("eval_count", 0),
        "total_duration_ms": data.get("total_duration", 0) // 1_000_000,
    }
    return text, stats


# ─── Public API ───────────────────────────────────────────────────────────────

async def health(base_url: str = "http://localhost:11434", timeout: float = 3.0) -> dict[str, Any]:
    try:
        async with _client(base_url, timeout) as c:
            r = await c.get("/api/version")
            r.raise_for_status()
            version = r.json().get("version", "unknown")
        return {"ok": True, "version": version, "base_url": base_url}
    except Exception as err:
        return {"ok": False, "error": str(err)}


async def list_models(base_url: str = "http://localhost:11434", timeout: float = 5.0) -> list[dict[str, Any]]:
    try:
        async with _client(base_url, timeout) as c:
            r = await c.get("/api/tags")
            r.raise_for_status()
            data = r.json()
    except Exception as err:
        log.warning("list_models error: %s", err)
        return []
    models = []
    for m in data.get("models", []):
        details = m.get("details", {})
        name = m.get("name", "")
        family = details.get("family", name.split(":")[0])
        models.append({
            "name": name,
            "size": m.get("size", 0),
            "family": family,
            "parameter_size": details.get("parameter_size", ""),
        })
    return models


async def classify(
    text: str,
    model: str = DEFAULT_MODEL,
    base_url: str = "http://localhost:11434",
    timeout: float = 60.0,
) -> dict[str, Any]:
    cleaned = _clean_for_analysis(text)
    snippet = cleaned[-MAX_INPUT_CHARS:] if len(cleaned) > MAX_INPUT_CHARS else cleaned
    log.debug("classify (ollama) → %d chars · model=%s", len(snippet), model)

    try:
        raw, stats = await _generate(
            base_url, model, SYSTEM_PROMPT, snippet,
            n_predict=512, temperature=0.1, timeout=timeout,
        )
    except Exception as err:
        log.warning("classify ollama error: %s", err)
        return {
            "intent": "in_progress", "questions": [], "question": None,
            "summary": f"(ollama error: {err})", "_error": str(err),
            "prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0,
        }

    log.debug("classify ← raw\n--- RAW ---\n%s\n--- END RAW ---", raw)

    m = _JSON_RE.search(raw)
    content = m.group(0) if m else raw
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        log.warning("classify: non-JSON output: %s", raw[:200])
        return {
            "intent": "in_progress", "questions": [], "question": None,
            "summary": "(unparseable output)", "_raw": raw[:500],
        }

    if not isinstance(parsed, dict):
        return {"intent": "in_progress", "questions": [], "summary": "(bad shape)"}

    intent = parsed.get("intent", "in_progress")
    if intent not in ("question", "completion", "in_progress"):
        intent = "in_progress"

    raw_qs: list[Any] = []
    if isinstance(parsed.get("questions"), list):
        raw_qs = parsed["questions"]
    elif isinstance(parsed.get("question"), dict):
        raw_qs = [parsed["question"]]
    elif isinstance(parsed.get("question"), list):
        raw_qs = parsed["question"]

    def _is_placeholder(s: str) -> bool:
        return bool(_PLACEHOLDER_RE.match(s.strip()))

    questions: list[dict[str, Any]] = []
    if intent == "question":
        for q in raw_qs:
            if not isinstance(q, dict):
                continue
            q_type = q.get("type", "text")
            if q_type not in ("text", "choice"):
                q_type = "text"
            opts_raw = q.get("options") or []
            if not isinstance(opts_raw, list):
                opts_raw = []
            opts = [
                str(o).strip() for o in opts_raw
                if str(o).strip() and not _is_placeholder(str(o).strip())
            ]
            prompt = str(q.get("prompt", "")).strip()
            if (
                not prompt
                or prompt.lower() in _FILLER_PROMPTS
                or len(prompt) < 4
                or _is_placeholder(prompt)
            ):
                continue
            questions.append({"prompt": prompt, "type": q_type, "options": opts})

    if intent == "question" and not questions:
        intent = "in_progress"
    if intent == "question":
        questions = _apply_choice_heuristics(questions)

    return {
        "intent": intent,
        "questions": questions,
        "question": questions[0] if questions else None,
        "summary": str(parsed.get("summary", "")).strip()[:200],
        "model": model,
        **stats,
    }


async def auto_answer(
    questions: list[dict],
    task: str,
    stage_title: str,
    model: str = DEFAULT_MODEL,
    base_url: str = "http://localhost:11434",
    timeout: float = 60.0,
) -> dict[str, Any]:
    q_lines: list[str] = []
    for i, q in enumerate(questions, 1):
        line = f"Q{i}. {q.get('prompt', '')}"
        opts = q.get("options") or []
        if q.get("type") == "choice" and opts:
            line += f"\n   選項: {', '.join(str(o) for o in opts)}"
        q_lines.append(line)

    user_msg = (
        f"任務描述: {task or '(未指定)'}\n"
        f"當前 Pipeline 階段: {stage_title or '(未知)'}\n\n"
        f"問題:\n" + "\n".join(q_lines)
    )

    try:
        raw, stats = await _generate(
            base_url, model, _AUTO_ANSWER_SYSTEM_PROMPT, user_msg,
            n_predict=256, temperature=0.3, timeout=timeout,
        )
    except Exception as err:
        log.warning("auto_answer ollama error: %s", err)
        return {"ok": False, "error": str(err), "answer": "", "answers": [],
                "prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}

    raw = re.sub(r'\s*\[end of text\]\s*$', '', raw, flags=re.IGNORECASE).strip()
    raw = re.sub(r'\s*<\|im_end\|>\s*$', '', raw).strip()

    def _clean_token(s: str) -> str:
        s = re.sub(r'\s*\[end of text\]\s*$', '', s, flags=re.IGNORECASE)
        return re.sub(r'\s*<\|im_end\|>\s*$', '', s).strip()

    if len(questions) == 1:
        answers = [_clean_token(raw)]
    else:
        answers: list[str] = []
        for i in range(len(questions)):
            pattern = rf"A{i + 1}\.\s*(.+?)(?=\nA{i + 2}\.|$)"
            mv = re.search(pattern, raw, re.DOTALL)
            answers.append(_clean_token(mv.group(1)) if mv else _clean_token(raw))

    if len(questions) == 1:
        combined = answers[0]
    else:
        combined = "\n\n".join(
            f"Q{i + 1}. {q.get('prompt', '')}\nA{i + 1}. {a}"
            for i, (q, a) in enumerate(zip(questions, answers))
        )

    if not combined.strip():
        return {"ok": False, "error": "LLM returned empty answer", "answer": "", "answers": []}

    return {"ok": True, "answer": combined, "answers": answers, **stats}


async def benchmark(
    base_url: str = "http://localhost:11434",
    progress_cb: Any = None,
    task_timeout: float = 25.0,
) -> list[dict[str, Any]]:
    all_models = await list_models(base_url)
    candidates = [m for m in all_models if m["family"] not in _SKIP_FAMILIES]
    log.info("benchmark (ollama): %d candidate model(s)", len(candidates))
    results: list[dict[str, Any]] = []

    for model_info in candidates:
        model_name = model_info["name"]
        task_results: list[dict[str, Any]] = []

        for task in _BENCHMARK_TASKS:
            t_start = asyncio.get_event_loop().time()
            passed = False
            try:
                raw, _ = await _generate(
                    base_url, model_name,
                    task["system"], task["user"],
                    n_predict=256, temperature=0.1, timeout=task_timeout,
                )
                passed = _check_task(task["id"], raw)
                log.info("benchmark %s %s → %s", model_name, task["id"], "✓" if passed else "✗")
            except Exception as err:
                log.info("benchmark %s %s → error: %s", model_name, task["id"], err)

            elapsed = round(asyncio.get_event_loop().time() - t_start, 1)
            task_results.append({"task_id": task["id"], "passed": passed, "elapsed_s": elapsed})
            score = sum(1 for t in task_results if t["passed"])

            if progress_cb is not None:
                try:
                    await progress_cb(model_name, task["id"], passed, elapsed, score)
                except Exception as cb_err:
                    log.warning("benchmark progress_cb error: %s", cb_err)

        score = sum(1 for t in task_results if t["passed"])
        results.append({
            "name": model_name,
            "tasks": task_results,
            "score": score,
            "passed": score >= 3,
        })

    return results


# ─── Model management ─────────────────────────────────────────────────────────

async def pull_model(
    name: str,
    base_url: str = "http://localhost:11434",
    progress_cb: Any = None,
    timeout: float = 600.0,
) -> AsyncIterator[dict[str, Any]]:
    """Stream pull progress from POST /api/pull.

    Yields dicts with keys: status, digest, total, completed (Ollama format).
    Raises on HTTP error.
    """
    url = base_url.rstrip("/") + "/api/pull"
    async with httpx.AsyncClient(timeout=timeout) as c:
        async with c.stream("POST", url, json={"name": name, "stream": True}) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.strip():
                    continue
                try:
                    data = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if progress_cb is not None:
                    try:
                        await progress_cb(data)
                    except Exception:
                        pass
                yield data


async def delete_model(
    name: str,
    base_url: str = "http://localhost:11434",
    timeout: float = 10.0,
) -> dict[str, Any]:
    try:
        async with _client(base_url, timeout) as c:
            r = await c.request("DELETE", "/api/delete", json={"name": name})
            r.raise_for_status()
        return {"ok": True}
    except Exception as err:
        return {"ok": False, "error": str(err)}
