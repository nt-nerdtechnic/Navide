"""Persistent pipeline stage registry.

Stages live in a single JSON file under the macOS app-data dir so users can
edit them from the Stage Manager window without recompiling the renderer.
Defaults are seeded on first load.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from .applog import app_data_dir

log = logging.getLogger("agent_team_backend.stages")

STAGES_FILE = "stages.json"


@dataclass
class SlotDef:
    agent_key: str
    role_key: str
    label: str
    kickoff_body: str
    # When true, this slot is the global Commander for the entire pipeline.
    # Configured in the stage editor; derived by the frontend on pipeline start.
    # At most one Commander across all stages is supported.
    is_commander: bool = False


@dataclass
class StageDef:
    id: str
    title: str
    short_title: str
    question: str
    description: str
    recommended_roles: list[str]
    sentinel: str
    slots: list[SlotDef] = field(default_factory=list)
    allow_questions: bool = False
    doc_query: str = ""


def default_stages() -> list[dict[str, Any]]:
    """Seed set — every stage is slots-based."""
    stages = [
        StageDef(
            id="01",
            title="01 Requirement Analysis",
            short_title="Requirements",
            question="要做什麼 / 不做什麼？",
            description="透過訪談收斂專案邊界、產出 PRD，明確專案目標與預期效益，避免後續「這不是我要的功能」爭議。",
            recommended_roles=["pm", "qa", "backend"],
            allow_questions=True,
            doc_query="project requirements, user stories, acceptance criteria",
            sentinel="---SPEC-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="pm",
                    label="Requirements",
                    is_commander=True,
                    kickoff_body="""[Stage 01 · Requirement Analysis]
任務：{{task}}

請以資深規格分析者的身份，產出這份內部系統的 PRD 草稿，內容必須包含：
1. 目標使用者與營運痛點（具體場景）。
2. MVP 必做功能（3-5 項，每項列出 actor / trigger / input / output / status）。
3. 明確「不做項目」（avoid scope creep）。
4. 5 個可測試的使用者驗收情境（UAT scenarios），含預期結果。
5. 風險與相依（外部系統 / 法遵 / 資料來源）。

關鍵未知資訊就用 QUESTION 區塊問我，不要憑空假設。

sentinel 輸出規則：
錯誤：完成了 ---SPEC-DONE---
錯誤：```
---SPEC-DONE---
```
正確：最後一行只有 ---SPEC-DONE---

完成後，最後一行只輸出 ---SPEC-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="02",
            title="02 System Planning",
            short_title="Planning",
            question="系統怎麼撐起來？",
            description="依 PRD 產出技術藍圖：framework 選擇、資料庫、ERD、API surface、安全決策、phased delivery 切片。這是後續設計與實作的技術基礎。",
            recommended_roles=["pm", "backend"],
            allow_questions=True,
            doc_query="system architecture, database schema, REST API design, authentication patterns",
            sentinel="---PLAN-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="pm",
                    label="Planning",
                    kickoff_body="""[Stage 02 · System Planning]
任務脈絡：{{task}}

你是系統架構師。依前一階段的 PRD（前置階段產出已附在最前面，請先閱讀），產出技術藍圖：
1. 系統技術藍圖：framework 選擇、資料庫、伺服器部署模式、外部整合清單。
2. 核心 ERD（entities、欄位型別、relations）。
3. API surface 列表（method、path、request/response schema 摘要、purpose）。
4. 安全性決策：驗證機制、敏感資料加密、CORS 策略。
5. Phased delivery 切片（slice 1..N），每片含「deliverables + 可驗收標準」。

如果有技術決策需要使用者確認（如技術棧選擇、預算考量、特殊限制），用 QUESTION 區塊詢問。
其餘不確定事項根據 PRD 與業界常規自行決策並說明。

sentinel 輸出規則：最後一行只有 ---PLAN-DONE---
完成後，最後一行只輸出 ---PLAN-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="03",
            title="03 UI/UX Design",
            short_title="Design",
            question="使用者看到什麼、怎麼操作？",
            description="依 PRD 需求與 Stage 02 技術藍圖，產出完整的 UI/UX 設計：頁面清單、wireframe、使用者旅程、設計規範。設計需對齊 API surface，確保前後端介面一致。",
            recommended_roles=["frontend", "pm"],
            allow_questions=False,
            doc_query="UI components, responsive design, accessibility, user interaction patterns",
            sentinel="---DESIGN-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="frontend",
                    label="Design",
                    kickoff_body="""[Stage 03 · UI/UX Design]
任務脈絡：{{task}}

你是 UI/UX 設計師。依前兩階段的 PRD 與系統架構藍圖（前置階段產出已附在最前面，請先閱讀），產出：
1. 主要頁面清單（含頁面名稱、用途、主要 CTA）。
2. 每個頁面的 wireframe 大綱：sections 佈局、主要 UI 元件、操作動線。
3. 完整使用者旅程（User Journey Map）：從進站到完成核心任務的每一步。
4. 設計規範草稿：色調方向、字體階層、行動裝置優先（mobile-first）規則。
5. 對使用者體驗影響最大的 3-5 個設計決策，附理由（需對齊 Stage 02 的 API surface）。

遇到不確定事項，根據 PRD 與業界常規自行決策，並在輸出中簡短說明理由，不要停下來問問題。

sentinel 輸出規則：最後一行只有 ---DESIGN-DONE---
完成後，最後一行只輸出 ---DESIGN-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="04",
            title="04 Development & Implementation",
            short_title="Build",
            question="怎麼把藍圖蓋出來？",
            description="Backend（codex）和 Frontend（claude）同時依 Stage 02/03 藍圖各自實作 slice 1，平行進行加速交付。",
            recommended_roles=["backend", "frontend", "mobile"],
            allow_questions=False,
            doc_query="API implementation, database queries, authentication, error handling, security best practices",
            sentinel="---BUILD-DONE---",
            slots=[
                SlotDef(
                    agent_key="codex",
                    role_key="backend",
                    label="Backend",
                    kickoff_body="""[Stage 04-A · 後端實作]
任務脈絡：{{task}}

你是後端工程師。依 Stage 02 的技術藍圖與 API surface（前置階段產出已附在最前面），實作 slice 1 後端：
1. 資料庫 schema / migration（含必要欄位、索引、外鍵）。
2. 核心 REST API 端點（至少完整實作 slice 1 主流程的 CRUD）。
3. 業務邏輯層：validations、error handling、status codes。
4. 環境設定與啟動說明（.env 範本、run 指令）。

遇到不確定事項，根據藍圖與業界常規自行決策並說明，不要停下來問問題。

完成後輸出「Handoff for QA」段：
- Endpoints 清單（method + path + 預期 response）
- 已知 edge cases / 潛在問題
- 給前端的 API 格式備注

sentinel 輸出規則：最後一行只有 ---BUILD-DONE---""",
                ),
                SlotDef(
                    agent_key="claude",
                    role_key="frontend",
                    label="Frontend",
                    kickoff_body="""[Stage 04-B · 前端實作]
任務脈絡：{{task}}

你是前端工程師。依 Stage 03 的 UI/UX wireframe 與 Stage 02 的 API surface（前置階段產出已附在最前面），實作 slice 1 前端：
1. 主要頁面骨架（components 結構、routing 設定）。
2. 與後端 API 的串接層（fetch/axios，含 loading / error state 處理）。
3. 表單驗證與使用者回饋（成功 toast、錯誤提示、空白狀態）。
4. Mobile-first RWD 基礎樣式。

遇到不確定事項，根據 wireframe 與 API surface 自行決策並說明，不要停下來問問題。

完成後輸出「Handoff for QA」段：
- UI 元件清單
- 已知視覺 edge cases / 待確認 API 格式
- 本地啟動說明

sentinel 輸出規則：最後一行只有 ---BUILD-DONE---""",
                ),
            ],
        ),
        StageDef(
            id="04.5",
            title="04.5 Security & Dead-Code Review",
            short_title="Review",
            question="程式碼有哪些安全疑慮？",
            description="靜態掃描 Stage 04 的實作成果：找出安全漏洞、死碼、跨 stage 協作斷層。",
            recommended_roles=["qa", "backend"],
            allow_questions=False,
            doc_query="security vulnerabilities, OWASP top 10, authentication bypass, input validation, common CVEs",
            sentinel="---REVIEW-DONE---",
            slots=[
                SlotDef(
                    agent_key="claude",
                    role_key="qa",
                    label="Security Review",
                    kickoff_body="""[Stage 04.5 · Security & Dead-Code Review]
任務脈絡：{{task}}

你是資安審查員。依前置階段的實作成果（前置階段產出已附在最前面，請先閱讀），進行靜態掃描：

1. **安全漏洞掃描**（必查）：
   - 未保護的 admin / 管理後台路由（缺少 requireAdmin() 或 requireAuth()）
   - Open Redirect：`searchParams.from`、`query.redirect` 等未驗證就傳給 router.push / redirect
   - 弱 secret fallback：`?? "dev-secret"` 或 `|| "hardcoded-value"` 之類的 anti-pattern
   - Sensitive data leak：console.log / logger 輸出未 redact 的密碼、token、個人資料

2. **死碼掃描**：
   - 建立但從未被任何檔案 import 的模組（lib/、utils/、hooks/ 底下）
   - 重複定義的常數 / 型別（多處各自定義同一個 enum / interface）

3. **跨 stage 一致性**：
   - Stage 03 產出的設計規範檔案是否被 Stage 04 實際使用？
   - 如未使用，明確列出「哪個檔案應該被哪個模組 import」

輸出格式（嚴格遵守）：
## 🔴 嚴重問題（必須修復）
## 🟡 中度問題
## 🟢 輕微問題 / 建議
## ✅ 通過檢查項目

每個問題包含：位置（檔案:行號）、現象、修復建議。

遇到不確定的地方，根據常規安全最佳實踐自行判斷並說明理由。

sentinel 輸出規則：最後一行只有 ---REVIEW-DONE---
完成後，最後一行只輸出 ---REVIEW-DONE---。""",
                ),
            ],
        ),
        StageDef(
            id="05",
            title="05 Testing & Acceptance",
            short_title="Testing",
            question="上線前還會炸嗎？",
            description="單元測試、整合測試 + 客戶 UAT。確認系統在極端操作下不會崩潰，且符合需求規格。",
            recommended_roles=["qa", "backend", "frontend"],
            allow_questions=False,
            doc_query="unit testing, integration testing, E2E testing, test coverage, mocking",
            sentinel="---TEST-DONE---",
            slots=[
                SlotDef(
                    agent_key="gemini",
                    role_key="qa",
                    label="Testing",
                    kickoff_body="""[Stage 05 · Testing]
任務脈絡：{{task}}

依 stage 04 交付的 slice 1，輸出測試矩陣 + 1-2 個關鍵流程的自動化腳本 + UAT 清單。
完成後在「測試總結」段列所有 BLOCKER bugs 與測試通過的功能清單，即視為本專案交付完成。

重要：請精簡輸出，完整報告不超過 3000 字。測試矩陣用表格呈現，避免冗長說明。

sentinel 輸出規則：最後一行只有 ---TEST-DONE---
完成後，最後一行只輸出 ---TEST-DONE---。""",
                ),
            ],
        ),
    ]
    return [_stage_to_dict(s) for s in stages]


def _stage_to_dict(s: StageDef) -> dict[str, Any]:
    return asdict(s)


class StagesStore:
    def __init__(self, path: Path | None = None) -> None:
        self._path = path or (app_data_dir() / STAGES_FILE)

    @property
    def path(self) -> Path:
        return self._path

    def _ensure_dir(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            seed = default_stages()
            self._write(seed)
            return seed
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            if not isinstance(data, list):
                raise ValueError("stages.json must contain a JSON array")
            return [_migrate(s) for s in data]
        except Exception as err:  # noqa: BLE001
            log.warning("stages.json corrupt (%s); regenerating defaults", err)
            seed = default_stages()
            self._write(seed)
            return seed

    def _write(self, stages: list[dict[str, Any]]) -> None:
        self._ensure_dir()
        tmp = self._path.with_suffix(self._path.suffix + ".tmp")
        tmp.write_text(json.dumps(stages, indent=2, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self._path)

    # ---- public API ----

    def list(self) -> list[dict[str, Any]]:
        return self._read()

    def upsert(self, data: dict[str, Any]) -> dict[str, Any]:
        """Create or update a stage by id. Preserves order for existing, appends for new."""
        if not data.get("id"):
            raise ValueError("stage id is required")
        if not data.get("slots"):
            raise ValueError("stage must have at least one slot")
        stages = self._read()
        idx = next((i for i, s in enumerate(stages) if s.get("id") == data["id"]), -1)
        if idx >= 0:
            existing = stages[idx]
            updated = {**existing, **data}
            stages[idx] = updated
            self._write(stages)
            return updated
        else:
            stages.append(data)
            self._write(stages)
            return data

    def reorder(self, ids: list[str]) -> list[dict[str, Any]]:
        """Reorder stages to match the given id list."""
        stages = self._read()
        by_id = {s["id"]: s for s in stages}
        reordered = [by_id[sid] for sid in ids if sid in by_id]
        mentioned = set(ids)
        for s in stages:
            if s["id"] not in mentioned:
                reordered.append(s)
        self._write(reordered)
        return reordered

    def delete(self, id: str) -> list[dict[str, Any]]:
        stages = self._read()
        new_stages = [s for s in stages if s.get("id") != id]
        if len(new_stages) == len(stages):
            raise KeyError(f"stage not found: {id}")
        if not new_stages:
            raise ValueError("cannot delete the last remaining stage")
        self._write(new_stages)
        return new_stages

    def reset(self) -> list[dict[str, Any]]:
        seed = default_stages()
        self._write(seed)
        return seed


def _migrate(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip legacy fields and migrate to is_commander format."""
    _LEGACY_STAGE_MANAGER = (
        "manager_enabled", "manager_agent_key", "manager_role_key",
        "manager_tick_seconds", "manager_max_ticks", "manager_prompt_body",
    )
    _LEGACY = ("default_agent", "default_role", "kickoff_prompt", *_LEGACY_STAGE_MANAGER)
    cleaned = {k: v for k, v in raw.items() if k not in _LEGACY}
    slots = cleaned.get("slots") or []
    if not slots and raw.get("default_agent"):
        # Old single-agent format → wrap into one slot
        cleaned["slots"] = [{
            "agent_key": raw["default_agent"],
            "role_key": raw.get("default_role", ""),
            "label": raw.get("short_title", "Agent"),
            "kickoff_body": raw.get("kickoff_prompt", ""),
            "is_commander": False,
        }]
        log.info("Migrated stage '%s' from legacy format to slots", raw.get("id"))
    else:
        for s in cleaned.get("slots") or []:
            # Migrate old is_manager → is_commander
            if "is_manager" in s:
                s.setdefault("is_commander", s.pop("is_manager"))
            else:
                s.setdefault("is_commander", False)
    return cleaned
