"""Local-model analyzer for pipeline intelligence.

Uses llama.cpp (llama-cli) directly with GGUF files from Ollama's blob store —
no separate Ollama server process needed.

  ollama pull qwen2.5-coder          # one-time download
  ~/.ollama/models/blobs/sha256-xxx  # shared GGUF
  llama-cli -m <that file>           # what we call here
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any

log = logging.getLogger("agent_team_backend.analyzer")

# ─── Configuration ────────────────────────────────────────────────────────────

OLLAMA_MODELS_DIR = Path(
    os.environ.get("OLLAMA_MODELS", str(Path.home() / ".ollama" / "models"))
)
LLAMA_CLI = os.environ.get("LLAMA_CLI", "llama-completion")
DEFAULT_MODEL = "qwen2.5-coder:latest"
MAX_INPUT_CHARS = 3500
N_GPU_LAYERS = int(os.environ.get("LLAMA_N_GPU_LAYERS", "99"))   # Metal/CUDA
CONTEXT_SIZE = int(os.environ.get("LLAMA_CONTEXT_SIZE", "4096"))

# ─── System prompt ────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """你是 Navide (Agent-Team) pipeline 的判讀器。給你一段另一個 AI agent 剛剛輸出的文字，判斷它的意圖並回傳結構化 JSON。

重要前提：你看到的文字是 agent **已經停止輸出後**的畫面快照，不是即時串流。所以「文字裡有完整內容、agent 卻沒有繼續動作」代表它在等使用者，不是還在跑。

intent 三選一：
- "question": agent 在詢問使用者、或列出選項/方案要使用者挑選、或拋出需要使用者拍板的決定，然後停下來等回答。**只要出現「請選擇 / 請問 / 你想要 / 以下哪 / 要不要 / 哪一種 / 列出帶編號或項目符號的選項並等待挑選」這類等待輸入的訊號，就判 question**，不要因為它「正在描述/整理選項」就誤判成 in_progress。
- "completion": agent 已完成本階段工作（不論有沒有印 sentinel 字串），輸出像是總結、產出物、收尾。
- "in_progress": **只有**在 agent 明顯被中途截斷（句子沒寫完）、或畫面只剩 spinner/狀態列而沒有實質內容時才用。有完整內容又在等使用者回應，絕對不是 in_progress。

如果 intent 是 question，questions 必須是陣列，且**只能包含輸入文字中實際存在的問題**：
- prompt: 完整保留原文問題，不要截短、不要改寫（去掉問號以外的標點雜訊即可）
- type:
   * "choice" 若問題是封閉式選擇（原文有列出選項、或問題本身明顯是選擇題如等級/方式/是否）
   * "text" 開放式自由回答（如名稱、URL、預算金額、自由描述）
- options:
   * 若原文**明確列出選項**（編號 1./2./3.、字母 a)/b)、dash - 開頭）：逐項列出核心文字（去掉編號/dash/TUI 殘留）
   * 若原文**沒有列出選項但問題是封閉式**（如「要哪個層級？」「哪種模式？」）：根據問題語意**推測 3-4 個合理選項**
   * "text" 問題一律用空陣列

範例輸入：
「請告訴我：1. 主要市場？(A)台灣 (B)台灣+東南亞 (C)全球 — 2. 預算多少？— 3. 年齡驗證要做到哪個層級？」

對應輸出：
{"intent":"question","questions":[
  {"prompt":"主要市場是哪裡？","type":"choice","options":["台灣","台灣+東南亞","全球"]},
  {"prompt":"預算多少？","type":"text","options":[]},
  {"prompt":"年齡驗證要做到哪個層級？","type":"choice","options":["簡易聲明（彈窗自行聲明18+）","中等驗證（生日+OTP）","嚴格實名（身份證或TaiwanFidO）","待確認，先用最低限度"]}
],"summary":"agent 詢問市場 / 預算 / 年齡驗證"}

另一個範例輸入（最容易誤判成 in_progress，請特別注意）：
「我幫計算功能整理了幾個選項：
- 選項 A：只做加減乘除
- 選項 B：加上括號與運算優先順序
- 選項 C：支援科學記號與函式
你想要哪一種？」

對應輸出（這是 question，不是 in_progress）：
{"intent":"question","questions":[
  {"prompt":"計算功能你想要做到哪一種範圍？","type":"choice","options":["只做加減乘除","加上括號與運算優先順序","支援科學記號與函式"]}
],"summary":"agent 詢問計算功能要做到哪個範圍"}

注意：
- questions 的數量必須和輸入文字中的問題數量完全一致，不多不少
- 推測選項時只給 3-4 個，簡短，不超過 20 字/選項
- 忽略 TUI 狀態欄（如 "bypasspermissions on"、"shift+tab to cycle"、"esc to interrupt"）
- 忽略 markdown 修飾符（**、##、code fence）
- 不要把 sentinel 字串（---SPEC-DONE--- 等）當成問題

只回傳 JSON，不要 markdown code fence，不要其他註解：
{"intent":"...", "questions":[{"prompt":"...","type":"...","options":["..."]}], "summary":"agent 在做什麼，一句話"}
"""

# ─── PTY noise filter ─────────────────────────────────────────────────────────

_NOISE_KEYWORDS = (
    "bypasspermissions",
    "shift+tab",
    "tointerrupt",
    "esctointerrupt",
    "esc to interrupt",
)


def _clean_for_analysis(text: str) -> str:
    """Drop obvious TUI chrome lines + collapse repeated blank lines."""
    out: list[str] = []
    blank_run = 0
    for raw in text.splitlines():
        line = raw.rstrip()
        low = line.lower().replace(" ", "")
        if any(k in low for k in _NOISE_KEYWORDS):
            continue
        if not line.strip():
            blank_run += 1
            if blank_run > 1:
                continue
        else:
            blank_run = 0
        out.append(line)
    return "\n".join(out)


# ─── Ollama blob resolver ─────────────────────────────────────────────────────

def _find_gguf_path(model_name: str) -> Path:
    """Resolve 'name:tag' → ~/.ollama/models/blobs/sha256-xxxx.

    Ollama stores model blobs at:
      ~/.ollama/models/blobs/sha256-<hex>
    and references them from manifests at:
      ~/.ollama/models/manifests/registry.ollama.ai/library/<name>/<tag>
    """
    name, _, tag = model_name.partition(":")
    tag = tag or "latest"
    manifest_path = (
        OLLAMA_MODELS_DIR / "manifests" / "registry.ollama.ai" / "library" / name / tag
    )
    if not manifest_path.exists():
        raise FileNotFoundError(f"Ollama manifest not found: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for layer in manifest.get("layers", []):
        if layer.get("mediaType") == "application/vnd.ollama.image.model":
            # digest is "sha256:abc123..." → blob file is "sha256-abc123..."
            blob = OLLAMA_MODELS_DIR / "blobs" / layer["digest"].replace(":", "-")
            if not blob.exists():
                raise FileNotFoundError(f"GGUF blob not found: {blob}")
            return blob
    raise FileNotFoundError(f"No GGUF layer in manifest for {model_name!r}")


# ─── llama-cli runner ─────────────────────────────────────────────────────────

# Serialise all llama-cli calls (analyzer + doc_injector both import
# _run_llama_cli). A single llama-cli process saturates the GPU/Metal unified
# memory; two concurrent calls OOM-crash each other. One at a time is correct.
_llama_sem = asyncio.Semaphore(1)

_JSON_RE = re.compile(r"\{[\s\S]*\}", re.MULTILINE)

# llama.cpp perf-print stderr patterns. Format is stable across llama-cli and
# llama-completion (both end up calling llama_perf_print at exit).
# Example lines:
#   llama_perf_context_print: prompt eval time =     12.34 ms /     45 tokens (...)
#   llama_perf_context_print:        eval time =    678.90 ms /    123 tokens (...)
#   llama_perf_context_print:       total time =    691.24 ms /    168 tokens
_TIME_TOKENS_RE = re.compile(
    r"\b(eval time|prompt eval time|total time)\s*=\s*([\d.]+)\s*ms(?:\s*/\s*(\d+)\s*tokens)?",
    re.IGNORECASE,
)


def parse_llama_perf(stderr_text: str) -> dict:
    """Extract token counts + timing from llama.cpp perf-print output.

    Returns dict with prompt_eval_count, eval_count, total_duration_ms.
    Any field missing from the input stays 0 — we never fabricate.
    """
    out = {"prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}
    # Match line-by-line so "prompt eval time" can never be mistaken for
    # "eval time" — they are different *labels*, not a substring relationship.
    for raw_line in stderr_text.splitlines():
        line = raw_line.lower()
        m = _TIME_TOKENS_RE.search(line)
        if not m:
            continue
        label = m.group(1)
        ms = m.group(2)
        tokens = m.group(3)
        if label == "prompt eval time" and tokens:
            out["prompt_eval_count"] = int(tokens)
        elif label == "eval time" and tokens:
            out["eval_count"] = int(tokens)
        elif label == "total time":
            out["total_duration_ms"] = int(float(ms))
    return out


async def _run_llama_cli(
    system_prompt: str,
    user_message: str,
    gguf_path: Path,
    n_predict: int = 512,
    temperature: float = 0.1,
    timeout: float = 60.0,
    n_gpu_layers: int | None = None,
    llama_cli_override: str | None = None,
) -> tuple[str, dict]:
    """Spawn llama-cli, return (stdout_text, perf_stats).

    perf_stats has keys: prompt_eval_count, eval_count, total_duration_ms.
    If n_gpu_layers is None the module default N_GPU_LAYERS is used.
    Callers may pass 0 to force CPU-only mode (e.g. as a fallback after an
    OOM failure with GPU layers).

    All callers share _llama_sem so only one llama-cli process runs at a time.
    The semaphore timeout matches the caller's timeout so a queued call can
    still fail fast rather than waiting forever if the running call hangs.
    """
    if n_gpu_layers is None:
        n_gpu_layers = N_GPU_LAYERS
    cli = llama_cli_override or LLAMA_CLI
    async with _llama_sem:
        # Build full ChatML prompt manually — llama-completion's -sys flag does not
        # reliably apply the chat template for all models.
        full_prompt = (
            f"<|im_start|>system\n{system_prompt}<|im_end|>\n"
            f"<|im_start|>user\n{user_message}<|im_end|>\n"
            f"<|im_start|>assistant\n"
        )
        cmd = [
            cli,
            "-m", str(gguf_path),
            "-p", full_prompt,
            "-no-cnv",              # single-shot, no interactive loop
            "--no-display-prompt",
            "-n", str(n_predict),
            "--temp", str(temperature),
            "-ngl", str(n_gpu_layers),
            "-c", str(CONTEXT_SIZE),
            # NOTE: do NOT add --log-disable — it suppresses generated text too.
            # Logs go to stderr (we now parse them for token counts).
        ]
        log.debug("llama-cli spawn: %s -m %s ngl=%d ...", cli, gguf_path.name, n_gpu_layers)
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.DEVNULL,  # no interactive mode — exit after first response
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise TimeoutError(f"llama-cli timed out after {timeout}s")
        if proc.returncode != 0:
            err_text = stderr_b.decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"llama-cli exited {proc.returncode}: {err_text}")
        stderr_text = stderr_b.decode("utf-8", errors="replace")
        stats = parse_llama_perf(stderr_text)
        return stdout_b.decode("utf-8", errors="replace").strip(), stats


# ─── Post-LLM choice heuristics ──────────────────────────────────────────────

def _apply_choice_heuristics(questions: list[dict]) -> list[dict]:
    """Upgrade text→choice for obvious binary questions the LLM missed.

    Handles two common Chinese patterns:
    1. "A還是B？" → choice with options [A, B]
    2. "有沒有X" / "要不要X" → choice with options ["有", "沒有"]
    """
    result = []
    for q in questions:
        # Already a proper choice with options — keep as-is.
        if q.get("type") == "choice" and q.get("options"):
            result.append(q)
            continue

        prompt: str = q.get("prompt", "")

        # ── "A還是B" binary pattern ─────────────────────────────────────────
        m = re.search(r'(.+?)還是(.+?)(?:[？?]|$)', prompt)
        if m:
            raw_a = m.group(1).strip()
            raw_b = m.group(2).strip().rstrip("？?")
            # Strip common leading connector words from the A side
            a = re.sub(r'^(?:這是|是|目前是|現在是|要|想|我們)\s*', '', raw_a).strip()
            b = raw_b.strip()
            if a and b and len(a) <= 30 and len(b) <= 30:
                result.append({**q, "type": "choice", "options": [a, b]})
                continue

        # ── Yes / No binary pattern ──────────────────────────────────────────
        if re.search(r'有沒有|要不要|能不能|可不可以', prompt):
            result.append({**q, "type": "choice", "options": ["有", "沒有"]})
            continue

        # ── "是否" yes/no (not "是否列出", "是否包含" etc.) ─────────────────
        if re.search(r'是否(?!列|包|所要|需要|符合|達到|支援)', prompt):
            result.append({**q, "type": "choice", "options": ["是", "否"]})
            continue

        result.append(q)
    return result


# ─── Benchmark SOP ───────────────────────────────────────────────────────────

# Families to skip (embedding / vision — not generative text models)
_SKIP_FAMILIES = frozenset([
    "bge-m3", "nomic-embed-text", "llava", "deepseek-ocr",
    "qwen2.5vl", "mxbai-embed", "snowflake-arctic-embed",
])

# The 3 standardised benchmark tasks
_BENCHMARK_TASKS: list[dict[str, Any]] = [
    {
        "id": "T1",
        "name": "技術棧偵測",
        "system": (
            "你是一個技術棧分析器。分析任務描述，回傳 JSON，格式：\n"
            "{\"libraries\": [\"技術名稱\"], \"doc_query\": \"英文搜尋字串\"}\n"
            "只回傳 JSON，不要 markdown，不要其他文字。"
        ),
        "user": "任務：使用 Vue 3 + FastAPI 建立一個待辦清單 App，需要 JWT 認證。",
    },
    {
        "id": "T2",
        "name": "工作區摘要",
        "system": (
            "你是一個技術文件摘要助手。用一句話（100字以內，繁體中文）描述這個專案的功能。"
            "直接輸出摘要，不要額外說明。"
        ),
        "user": (
            "這個專案叫做 Navide (Agent-Team)，包含：Electron 前端（Vue 3 + TypeScript）、"
            "Python FastAPI 後端、llama-cli 本地 LLM 模組、WebSocket 通訊層。"
            "功能是管理多個 AI agent（Claude Code、Codex、Gemini）協同開發。"
        ),
    },
    {
        "id": "T3",
        "name": "相關性選擇",
        "system": (
            "你是一個文件相關性評分器。從候選文件清單選出最相關的 2 項，回傳 JSON：\n"
            "{\"selected\": [\"文件名稱\"], \"reason\": \"一句話原因\"}\n"
            "只回傳 JSON，不要 markdown，不要其他文字。"
        ),
        "user": (
            "任務：整合 Claude API 到 Python 後端\n"
            "候選文件：[\"claude api authentication\", \"vue routing guide\", "
            "\"fastapi middleware tutorial\", \"anthropic sdk python quickstart\"]"
        ),
    },
    {
        "id": "T4",
        "name": "CLI 意圖解析",
        "system": (
            "你是 Navide (Agent-Team) pipeline 的判讀器。"
            "給你一段 CLI agent 的輸出文字，判斷意圖並回傳 JSON：\n"
            "{\"intent\": \"question\", "
            "\"questions\": [{\"prompt\": \"問題文字\", \"type\": \"choice|text\", \"options\": [...]}], "
            "\"summary\": \"一句話說明\"}\n"
            "只回傳 JSON，不要 markdown，不要其他文字。"
        ),
        "user": (
            "bypasspermissions on  shift+tab to cycle  esc to interrupt\n"
            "我需要確認幾件事：\n"
            "1. 你要用哪種資料庫？(A) PostgreSQL (B) MySQL (C) SQLite\n"
            "2. API 要有認證嗎？\n"
            "---"
        ),
    },
]


def _safe_parse_json(text: str) -> dict | None:
    """Try to extract and parse the first JSON object from text."""
    m = _JSON_RE.search(text)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _check_task(task_id: str, raw: str) -> bool:
    """Return True if the model output passes the task criteria."""
    raw = raw.strip()
    if task_id == "T1":
        d = _safe_parse_json(raw)
        if not d:
            return False
        return (
            isinstance(d.get("libraries"), list)
            and len(d["libraries"]) > 0
            and isinstance(d.get("doc_query"), str)
            and len(d["doc_query"].strip()) > 3
        )
    elif task_id == "T2":
        return 10 < len(raw) < 300
    elif task_id == "T3":
        d = _safe_parse_json(raw)
        if not d:
            return False
        selected = d.get("selected")
        if not isinstance(selected, list) or len(selected) == 0:
            return False
        relevant_keywords = ("claude", "anthropic")
        return any(
            any(kw in s.lower() for kw in relevant_keywords)
            for s in selected
        )
    elif task_id == "T4":
        d = _safe_parse_json(raw)
        if not d:
            return False
        if d.get("intent") != "question":
            return False
        questions = d.get("questions") or []
        if not isinstance(questions, list) or len(questions) < 2:
            return False
        # At least one choice question that extracted database options
        db_keywords = ("postgresql", "mysql", "sqlite", "postgres")
        return any(
            q.get("type") == "choice"
            and any(
                any(kw in str(o).lower() for kw in db_keywords)
                for o in (q.get("options") or [])
            )
            for q in questions
        )
    return False


async def benchmark(
    progress_cb: Any = None,
    task_timeout: float = 25.0,
) -> list[dict[str, Any]]:
    """Run the 3-task SOP on all non-embedding/non-vision local models.

    progress_cb — optional async callable(model, task_id, passed, elapsed_s, score)
    Returns list of {name, tasks:[{task_id, passed, elapsed_s}], score, passed}.
    """
    all_models = await list_models()
    candidates = [
        m for m in all_models
        if m["family"] not in _SKIP_FAMILIES
    ]
    log.info("benchmark: %d candidate model(s)", len(candidates))

    results: list[dict[str, Any]] = []

    for model_info in candidates:
        model_name = model_info["name"]
        task_results: list[dict[str, Any]] = []

        for task in _BENCHMARK_TASKS:
            t_start = asyncio.get_event_loop().time()
            passed = False
            try:
                gguf_path = _find_gguf_path(model_name)
                raw, _ = await _run_llama_cli(
                    system_prompt=task["system"],
                    user_message=task["user"],
                    gguf_path=gguf_path,
                    n_predict=256,
                    temperature=0.1,
                    timeout=task_timeout,
                )
                passed = _check_task(task["id"], raw)
                log.info(
                    "benchmark %s %s → %s (raw=%r)",
                    model_name, task["id"], "✓" if passed else "✗", raw[:120],
                )
            except (TimeoutError, RuntimeError, FileNotFoundError) as err:
                log.info("benchmark %s %s → timeout/error: %s", model_name, task["id"], err)

            elapsed = round(asyncio.get_event_loop().time() - t_start, 1)
            task_results.append({"task_id": task["id"], "passed": passed, "elapsed_s": elapsed})
            score = sum(1 for t in task_results if t["passed"])

            if progress_cb is not None:
                try:
                    await progress_cb(model_name, task["id"], passed, elapsed, score)
                except Exception as cb_err:  # noqa: BLE001
                    log.warning("benchmark progress_cb error: %s", cb_err)

        score = sum(1 for t in task_results if t["passed"])
        results.append({
            "name": model_name,
            "tasks": task_results,
            "score": score,
            "passed": score >= 3,  # ≥3/4 tasks (75%) to qualify
        })

    return results


# ─── Public API ───────────────────────────────────────────────────────────────

async def list_models(base_url: str = "", timeout: float = 5.0) -> list[dict[str, Any]]:
    """Scan ~/.ollama/models/manifests and return available models."""
    lib_dir = OLLAMA_MODELS_DIR / "manifests" / "registry.ollama.ai" / "library"
    if not lib_dir.exists():
        return []
    models: list[dict[str, Any]] = []
    for name_dir in sorted(lib_dir.iterdir()):
        if not name_dir.is_dir():
            continue
        for tag_file in sorted(name_dir.iterdir()):
            if not tag_file.is_file():
                continue
            model_name = f"{name_dir.name}:{tag_file.name}"
            try:
                blob = _find_gguf_path(model_name)
                size = blob.stat().st_size
            except Exception:
                size = 0
            models.append({
                "name": model_name,
                "size": size,
                "family": name_dir.name,
                "parameter_size": "",
            })
    return models


async def health(
    base_url: str = "",
    timeout: float = 2.0,
    llama_cli_override: str | None = None,
    gguf_path_override: str | None = None,
) -> dict[str, Any]:
    """Check if llama-cli is in PATH and executable, and (if set) that the GGUF file exists."""
    cli = llama_cli_override or LLAMA_CLI
    cli_path = shutil.which(cli)
    if not cli_path:
        return {"ok": False, "error": f"'{cli}' not found in PATH"}
    proc: asyncio.subprocess.Process | None = None
    try:
        proc = await asyncio.create_subprocess_exec(
            cli_path, "--version",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=5.0)
        except asyncio.TimeoutError:
            proc.kill()
            await proc.communicate()
            raise
        raw = (stdout_b or stderr_b).decode("utf-8", errors="replace").strip()
        version = raw.splitlines()[0] if raw else "unknown"
    except Exception as err:
        return {"ok": False, "error": str(err)}

    result: dict[str, Any] = {"ok": True, "version": version, "cli": cli_path}

    if gguf_path_override:
        p = Path(gguf_path_override)
        if not p.exists():
            result["gguf_warning"] = f"GGUF file not found: {gguf_path_override}"
        else:
            result["gguf_size"] = p.stat().st_size

    return result


async def classify(
    text: str,
    model: str = DEFAULT_MODEL,
    base_url: str = "",
    timeout: float = 60.0,
    llama_cli_override: str | None = None,
    gguf_path_override: str | None = None,
) -> dict[str, Any]:
    """Classify the most recent agent output via llama-cli."""
    cleaned = _clean_for_analysis(text)
    snippet = cleaned[-MAX_INPUT_CHARS:] if len(cleaned) > MAX_INPUT_CHARS else cleaned

    log.debug(
        "classify → %d chars · model=%s\n--- SNIPPET ---\n%s\n--- END SNIPPET ---",
        len(snippet), model, snippet,
    )

    # Resolve model name → GGUF path (override takes precedence)
    if gguf_path_override:
        gguf_path = Path(gguf_path_override)
        if not gguf_path.exists():
            log.warning("classify: gguf_path_override not found — %s", gguf_path_override)
            return {
                "intent": "in_progress", "questions": [], "question": None,
                "summary": f"(GGUF file not found: {gguf_path_override})", "_error": str(gguf_path_override),
            }
    else:
        try:
            gguf_path = _find_gguf_path(model)
        except FileNotFoundError as err:
            log.warning("classify: model not found — %s", err)
            return {
                "intent": "in_progress", "questions": [], "question": None,
                "summary": f"(model not found: {err})", "_error": str(err),
            }

    # Run inference — try GPU first, fall back to CPU if OOM/crash.
    # Multiple Claude Code panes sharing Metal/unified memory can exhaust
    # GPU memory, causing llama-cli to exit with code 1 during model init.
    raw: str | None = None
    stats: dict = {"prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}
    last_err: Exception | None = None
    for attempt_ngl in ([N_GPU_LAYERS, 0] if N_GPU_LAYERS > 0 else [0]):
        try:
            raw, stats = await _run_llama_cli(
                system_prompt=SYSTEM_PROMPT,
                user_message=snippet,
                gguf_path=gguf_path,
                timeout=timeout,
                n_gpu_layers=attempt_ngl,
                llama_cli_override=llama_cli_override,
            )
            if attempt_ngl == 0 and N_GPU_LAYERS > 0:
                log.warning("classify: GPU mode failed, used CPU fallback")
            break
        except Exception as err:
            last_err = err
            if attempt_ngl == 0:
                # CPU also failed — give up
                log.warning("classify llama-cli error (CPU): %s", err)
            else:
                log.warning("classify llama-cli error (GPU ngl=%d), retrying CPU: %s", attempt_ngl, err)

    if raw is None:
        return {
            "intent": "in_progress", "questions": [], "question": None,
            "summary": f"(llama-cli error: {last_err})", "_error": str(last_err),
            "prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0,
        }

    log.debug(
        "classify ← raw output\n--- RAW ---\n%s\n--- END RAW ---",
        raw,
    )

    # Extract first JSON object from output (llama-cli may emit extra whitespace)
    content = raw
    m = _JSON_RE.search(raw)
    if m:
        content = m.group(0)

    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        log.warning("classify: non-JSON output: %s", raw[:200])
        return {
            "intent": "in_progress", "questions": [], "question": None,
            "summary": "(unparseable output)", "_raw": raw[:500],
        }

    # ── Normalise shape ───────────────────────────────────────────────────────
    if not isinstance(parsed, dict):
        return {"intent": "in_progress", "questions": [], "summary": "(bad shape)"}
    intent = parsed.get("intent", "in_progress")
    if intent not in ("question", "completion", "in_progress"):
        intent = "in_progress"

    # Accept both `questions` (array) and `question` (legacy single object)
    raw_qs: list[Any] = []
    if isinstance(parsed.get("questions"), list):
        raw_qs = parsed["questions"]
    elif isinstance(parsed.get("question"), dict):
        raw_qs = [parsed["question"]]
    elif isinstance(parsed.get("question"), list):
        raw_qs = parsed["question"]

    # Filter LLM filler / placeholder values
    _FILLER_PROMPTS = {"無", "无", "n/a", "na", "none", "null", "－", "-", "—", ""}
    _PLACEHOLDER_RE = re.compile(r"^<[^>]+>$")

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
                log.debug("skip filler/placeholder prompt: %r", prompt)
                continue
            # Do NOT fall back to text when opts is empty — the LLM may have
            # inferred a choice question that still lacks explicit option text
            # (e.g. options were corrupted by PTY noise).  The empty-options
            # case is handled gracefully by the UI (shows as text input) but
            # keeping type="choice" signals intent to the caller.
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
        "prompt_eval_count": stats.get("prompt_eval_count", 0),
        "eval_count": stats.get("eval_count", 0),
        "total_duration_ms": stats.get("total_duration_ms", 0),
    }


# ─── Auto-answer system prompt ────────────────────────────────────────────────

_AUTO_ANSWER_SYSTEM_PROMPT = """你是 Navide (Agent-Team) pipeline 的全自動決策者。
給你一個 AI agent 提出的問題清單以及當前任務背景，替使用者自動選出或填入最佳答案。

輸出格式規則（嚴格遵守）：
- 只有一個問題：直接輸出答案，不加任何前綴、標籤、Q/A 標記
- 多個問題：每個問題只輸出一行，格式必須是 "A1. 答案" / "A2. 答案"（A 開頭，不是 Q）
- 選擇題（type=choice）：從選項中選一個，只輸出選項原文，不加任何額外文字
- 開放題（type=text）：給出簡短具體的答案，直接切入重點，不超過 60 字

範例 — 單題選擇：
  輸入: Q1. 選哪個DB? (選項: PostgreSQL, MySQL)
  輸出: PostgreSQL

範例 — 多題：
  輸入: Q1. 選哪個DB? (選項: PostgreSQL, MySQL) / Q2. 要幾個API?
  輸出:
  A1. PostgreSQL
  A2. 5個基礎CRUD端點

禁止：解釋、JSON、「根據任務...」、「我建議...」之類的前言。只輸出答案本身。
"""


async def auto_answer(
    questions: list[dict],
    task: str,
    stage_title: str,
    model: str = DEFAULT_MODEL,
    timeout: float = 60.0,
    llama_cli_override: str | None = None,
    gguf_path_override: str | None = None,
) -> dict[str, Any]:
    """Use LLM to automatically generate answers for agent questions."""
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

    if gguf_path_override:
        gguf_path = Path(gguf_path_override)
        if not gguf_path.exists():
            return {"ok": False, "error": f"GGUF file not found: {gguf_path_override}", "answer": "", "answers": []}
    else:
        try:
            gguf_path = _find_gguf_path(model)
        except FileNotFoundError as err:
            log.warning("auto_answer: model not found — %s", err)
            return {"ok": False, "error": str(err), "answer": "", "answers": []}

    raw: str | None = None
    stats: dict = {"prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0}
    for attempt_ngl in ([N_GPU_LAYERS, 0] if N_GPU_LAYERS > 0 else [0]):
        try:
            raw, stats = await _run_llama_cli(
                system_prompt=_AUTO_ANSWER_SYSTEM_PROMPT,
                user_message=user_msg,
                gguf_path=gguf_path,
                n_predict=256,
                temperature=0.3,
                timeout=timeout,
                n_gpu_layers=attempt_ngl,
                llama_cli_override=llama_cli_override,
            )
            break
        except Exception as err:
            log.warning("auto_answer llama-cli error (ngl=%d): %s", attempt_ngl, err)
            if attempt_ngl == 0:
                return {
                    "ok": False, "error": str(err), "answer": "", "answers": [],
                    "prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0,
                }

    if raw is None:
        return {
            "ok": False, "error": "LLM inference failed", "answer": "", "answers": [],
            "prompt_eval_count": 0, "eval_count": 0, "total_duration_ms": 0,
        }

    # Log raw output at INFO so "思考後沒有答案" cases are diagnosable.
    log.info("auto_answer raw LLM output (%d chars): %s", len(raw), raw[:300])

    # Strip llama-cli end-of-generation tokens that sometimes leak into output
    raw = re.sub(r'\s*\[end of text\]\s*$', '', raw, flags=re.IGNORECASE).strip()
    raw = re.sub(r'\s*<\|im_end\|>\s*$', '', raw).strip()

    def _clean_token(s: str) -> str:
        s = re.sub(r'\s*\[end of text\]\s*$', '', s, flags=re.IGNORECASE)
        s = re.sub(r'\s*<\|im_end\|>\s*$', '', s)
        return s.strip()

    # Parse per-question answers
    if len(questions) == 1:
        answers = [_clean_token(raw)]
    else:
        answers: list[str] = []
        for i in range(len(questions)):
            pattern = rf"A{i + 1}\.\s*(.+?)(?=\nA{i + 2}\.|$)"
            m = re.search(pattern, raw, re.DOTALL)
            answers.append(_clean_token(m.group(1)) if m else _clean_token(raw))

    # Build combined answer string (mirrors onAnswerQuestion's buildCombined format)
    if len(questions) == 1:
        combined = answers[0]
    else:
        combined = "\n\n".join(
            f"Q{i + 1}. {q.get('prompt', '')}\nA{i + 1}. {a}"
            for i, (q, a) in enumerate(zip(questions, answers))
        )

    if not combined.strip():
        log.warning("auto_answer: LLM returned empty answer after parsing. raw=%r", raw[:200])
        return {"ok": False, "error": "LLM returned empty answer", "answer": "", "answers": []}

    log.info("auto_answer result: %s", combined[:200])
    return {
        "ok": True, "answer": combined, "answers": answers,
        "prompt_eval_count": stats.get("prompt_eval_count", 0),
        "eval_count": stats.get("eval_count", 0),
        "total_duration_ms": stats.get("total_duration_ms", 0),
    }
