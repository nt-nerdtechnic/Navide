"""voice.* WebSocket handlers, end to end through app.handle_message with the
fake sidecar."""

from __future__ import annotations

import asyncio
import base64
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app as app_module
from agent_team_backend import stt_service, voice_handlers

FAKE = Path(__file__).with_name("fake_navide_stt.py")
SECOND = 16_000 * 2


class _Session:
    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.dead = False

    async def send_json(self, message: dict) -> None:
        self.sent.append(message)


async def call(session: _Session, msg_type: str, payload: dict | None = None) -> dict | None:
    before = len(session.sent)
    await app_module.handle_message(session, {"id": "m", "type": msg_type, "payload": payload or {}})  # type: ignore[arg-type]
    if len(session.sent) == before:
        return None
    reply = session.sent[-1]
    assert reply["type"] == f"{msg_type}.result"
    assert reply["ok"] is True, reply
    return reply["payload"]


@pytest.fixture
async def voice(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    monkeypatch.setattr(stt_service, "sidecar_path", lambda: FAKE)
    monkeypatch.setattr(
        stt_service, "_sidecar_argv", lambda binary, model: [sys.executable, str(binary), "--model", str(model)]
    )
    monkeypatch.setattr(stt_service, "model_info", lambda: {"present": True, "bytes": 1, "path": "m"})
    temp_dir = tmp_path / "tmp"
    temp_dir.mkdir()
    monkeypatch.setattr(tempfile, "tempdir", str(temp_dir))
    sidecar = stt_service.SttSidecar()
    monkeypatch.setattr(stt_service, "_sidecar", sidecar)
    monkeypatch.setattr(voice_handlers, "_active", None)
    yield temp_dir
    await sidecar.stop()


async def _record(session: _Session, session_id: str, seconds: float, chunk_s: float = 0.25) -> None:
    per_chunk = int(SECOND * chunk_s)
    total = int(SECOND * seconds)
    seq = 0
    while total > 0:
        size = min(per_chunk, total)
        pcm = base64.b64encode(b"\x01\x00" * (size // 2)).decode()
        assert await call(session, "voice.chunk", {"sessionId": session_id, "seq": seq, "pcm": pcm}) is None
        total -= size
        seq += 1


async def test_happy_path(voice: Path) -> None:
    session = _Session()
    status = await call(session, "voice.status")
    assert status["sidecar"] == "ok" and status["running"] is False and status["gpu"] is None
    start = await call(session, "voice.start")
    assert start["ok"] is True
    sid = start["sessionId"]
    await _record(session, sid, 0.5)
    stop = await call(session, "voice.stop", {"sessionId": sid, "initialPrompt": "hint"})
    assert stop == {"ok": True, "text": f"bytes={SECOND // 2} lang=zh prompt=hint", "ms": 5, "durationMs": 500}
    assert list(voice.iterdir()) == []  # temp PCM removed
    status = await call(session, "voice.status")
    assert status["running"] is True and status["gpu"] is False


async def test_sidecar_missing(voice: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "sidecar_path", lambda: None)
    session = _Session()
    assert await call(session, "voice.start") == {"ok": False, "reason": "sidecar-missing"}
    assert (await call(session, "voice.status"))["sidecar"] == "missing"


async def test_model_missing(voice: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "model_info", lambda: {"present": False, "bytes": 0, "path": "m"})
    assert await call(_Session(), "voice.start") == {"ok": False, "reason": "model-missing"}


async def test_sidecar_failed(voice: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_STT_MODE", "fatal")
    session = _Session()
    assert await call(session, "voice.start") == {"ok": False, "reason": "sidecar-failed"}
    monkeypatch.setenv("FAKE_STT_MODE", "ok")
    assert (await call(session, "voice.start"))["ok"] is True  # the failed claim was released


async def test_busy_until_stop_cancel_or_disconnect(voice: Path) -> None:
    a, b = _Session(), _Session()
    sid = (await call(a, "voice.start"))["sessionId"]
    assert await call(b, "voice.start") == {"ok": False, "reason": "busy"}
    # Another window cannot stop or feed a recording it does not own.
    assert await call(b, "voice.stop", {"sessionId": sid}) == {"ok": False, "reason": "no-session"}
    assert await call(a, "voice.cancel", {"sessionId": sid}) == {"ok": True}
    assert await call(a, "voice.stop", {"sessionId": sid}) == {"ok": False, "reason": "no-session"}
    sid = (await call(b, "voice.start"))["sessionId"]
    voice_handlers.drop_owner(b)
    assert (await call(a, "voice.start"))["ok"] is True


async def test_too_short_is_empty_text(voice: Path) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 0.2, chunk_s=0.1)
    assert await call(session, "voice.stop", {"sessionId": sid}) == {
        "ok": True, "text": "", "ms": 0, "durationMs": 200,
    }


async def test_chunks_capped_at_60s_and_ordered_by_seq(voice: Path) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 61, chunk_s=1)
    rec = voice_handlers._active
    assert rec is not None and rec.size == voice_handlers.MAX_PCM_BYTES
    # Duplicate seq and garbage frames are ignored.
    await call(session, "voice.chunk", {"sessionId": sid, "seq": 0, "pcm": "AAAA"})
    await call(session, "voice.chunk", {"sessionId": sid, "seq": 99, "pcm": "not base64!"})
    stop = await call(session, "voice.stop", {"sessionId": sid, "language": "en"})
    assert stop["durationMs"] == 60_000
    assert stop["text"] == f"bytes={voice_handlers.MAX_PCM_BYTES} lang=en prompt=-"


async def test_stop_after_sidecar_crash_reports_and_respawns(voice: Path) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 0.5)
    sidecar = stt_service.get_sidecar()
    sidecar._proc.kill()
    await sidecar._proc.wait()
    # The reader notices the exit; a stop now respawns and transcribes.
    stop = await call(session, "voice.stop", {"sessionId": sid})
    assert stop["ok"] is True and stop["text"].startswith("bytes=")


async def test_model_download_answers_then_broadcasts(voice: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    events: list[dict] = []

    async def fake_broadcast(event: dict, *, exclude: Any = None) -> None:
        events.append(event)

    async def fake_download(on_progress) -> Path:
        await on_progress(10, 100)
        return Path("m")

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    monkeypatch.setattr(stt_service, "model_info", lambda: {"present": False, "bytes": 0, "path": "m"})
    monkeypatch.setattr(stt_service, "download_model", fake_download)
    assert await call(_Session(), "voice.model.download") == {"ok": True}
    await asyncio.wait_for(voice_handlers._download_task, 5)
    payloads = [e["payload"] for e in events if e["type"] == "voice.model.progress"]
    assert payloads[0] == {"bytes": 10, "total": 100, "done": False}
    assert payloads[-1]["done"] is True and "error" not in payloads[-1]

    async def failing_download(on_progress) -> Path:
        raise stt_service.ModelDownloadError("all sources failed")

    events.clear()
    monkeypatch.setattr(stt_service, "download_model", failing_download)
    await call(_Session(), "voice.model.download")
    await asyncio.wait_for(voice_handlers._download_task, 5)
    assert events[-1]["payload"]["done"] is True
    assert events[-1]["payload"]["error"] == "all sources failed"
