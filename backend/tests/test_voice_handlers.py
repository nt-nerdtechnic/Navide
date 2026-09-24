"""voice.* WebSocket handlers, end to end through app.handle_message with the
fake sidecar."""

from __future__ import annotations

import asyncio
import base64
import sys
import tempfile
import threading
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
    monkeypatch.setattr(voice_handlers, "_disabled", False)
    yield temp_dir
    await sidecar.stop()


LOUD = 4096  # s16 sample value well above SILENT_PEAK
PAD = SECOND // 2  # zeros appended before transcription


async def _record(
    session: _Session, session_id: str, seconds: float, chunk_s: float = 0.25, sample: int = LOUD,
) -> None:
    per_chunk = int(SECOND * chunk_s)
    total = int(SECOND * seconds)
    seq = 0
    frame = sample.to_bytes(2, "little", signed=True)
    while total > 0:
        size = min(per_chunk, total)
        pcm = base64.b64encode(frame * (size // 2)).decode()
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
    assert stop == {
        "ok": True, "text": f"bytes={SECOND // 2 + PAD} lang=zh prompt=hint", "ms": 5, "durationMs": 500, "peak": LOUD,
    }
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
        "ok": True, "text": "", "ms": 0, "durationMs": 200, "peak": LOUD,
    }


async def test_chunks_capped_at_5min_and_ordered_by_seq(voice: Path) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 301, chunk_s=1)
    rec = voice_handlers._active
    assert rec is not None and rec.size == voice_handlers.MAX_PCM_BYTES
    # Duplicate seq and garbage frames are ignored.
    await call(session, "voice.chunk", {"sessionId": sid, "seq": 0, "pcm": "AAAA"})
    await call(session, "voice.chunk", {"sessionId": sid, "seq": 99, "pcm": "not base64!"})
    stop = await call(session, "voice.stop", {"sessionId": sid, "language": "en"})
    assert stop["durationMs"] == 300_000
    assert stop["text"] == f"bytes={voice_handlers.MAX_PCM_BYTES + PAD} lang=en prompt=-"


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


async def test_silent_input_is_not_transcribed_and_reports_peak(
    voice: Path, caplog: pytest.LogCaptureFixture,
) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 1.0, sample=1)
    with caplog.at_level("INFO", logger=voice_handlers.__name__):
        stop = await call(session, "voice.stop", {"sessionId": sid})
    # The fake sidecar would have answered "bytes=…"; silence never reaches it.
    assert stop == {"ok": True, "text": "", "ms": 0, "durationMs": 1000, "peak": 1}
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("voice.stop ")]
    assert lines == ["voice.stop duration_ms=1000 chunks=4 bytes=32000 peak=1 rms=1.0"]


async def test_stop_logs_one_info_line_with_levels(voice: Path, caplog: pytest.LogCaptureFixture) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    await _record(session, sid, 0.5, sample=-LOUD)
    with caplog.at_level("INFO", logger=voice_handlers.__name__):
        stop = await call(session, "voice.stop", {"sessionId": sid})
    assert stop["peak"] == LOUD and stop["text"].startswith("bytes=")
    lines = [r.getMessage() for r in caplog.records if r.getMessage().startswith("voice.stop ")]
    assert lines == [f"voice.stop duration_ms=500 chunks=2 bytes=16000 peak={LOUD} rms={LOUD}.0"]


async def test_prewarm_starts_the_sidecar_without_claiming_a_recording(voice: Path) -> None:
    session = _Session()
    assert await call(session, "voice.prewarm") == {"ok": True}
    assert voice_handlers._active is None
    assert (await call(session, "voice.status"))["running"] is True
    # A second window can still start right away.
    assert (await call(_Session(), "voice.start"))["ok"] is True


async def test_prewarm_reports_missing_parts(voice: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stt_service, "model_info", lambda: {"present": False, "bytes": 0, "path": "m"})
    assert await call(_Session(), "voice.prewarm") == {"ok": False, "reason": "model-missing"}
    monkeypatch.setattr(stt_service, "sidecar_path", lambda: None)
    assert await call(_Session(), "voice.prewarm") == {"ok": False, "reason": "sidecar-missing"}
    assert stt_service.peek_sidecar() is None or not stt_service.peek_sidecar().running


async def test_shutdown_stops_the_sidecar_and_drops_the_recording(voice: Path) -> None:
    session = _Session()
    sid = (await call(session, "voice.start"))["sessionId"]
    assert stt_service.get_sidecar().running
    assert await call(session, "voice.shutdown") == {"ok": True}
    assert not stt_service.get_sidecar().running
    assert await call(session, "voice.stop", {"sessionId": sid}) == {"ok": False, "reason": "no-session"}


async def test_same_window_restart_supersedes_its_abandoned_start(voice: Path) -> None:
    a = _Session()
    old = (await call(a, "voice.start"))["sessionId"]
    # The window gave up on that start (Esc while loading) and pressed again.
    new = (await call(a, "voice.start"))["sessionId"]
    assert new != old
    assert await call(a, "voice.stop", {"sessionId": old}) == {"ok": False, "reason": "no-session"}
    assert await call(_Session(), "voice.start") == {"ok": False, "reason": "busy"}


async def _racing_shutdown(msg_type: str) -> dict:
    """Send ``msg_type`` without awaiting it, shut down at once, then await it."""
    session = _Session()
    task = asyncio.create_task(call(session, msg_type))
    await asyncio.sleep(0)  # the request is now inside its first await
    assert await call(session, "voice.shutdown") == {"ok": True}
    return await asyncio.wait_for(task, 30)


async def test_prewarm_racing_shutdown_leaves_no_sidecar(voice: Path) -> None:
    assert await _racing_shutdown("voice.prewarm") == {"ok": False, "reason": "disabled"}
    sidecar = stt_service.peek_sidecar()
    assert sidecar is None or not sidecar.running
    # Switching back on later works as before.
    assert await call(_Session(), "voice.prewarm") == {"ok": True}
    assert stt_service.get_sidecar().running


async def test_start_racing_shutdown_fails_and_leaves_no_sidecar(voice: Path) -> None:
    assert await _racing_shutdown("voice.start") == {"ok": False, "reason": "disabled"}
    sidecar = stt_service.peek_sidecar()
    assert sidecar is None or not sidecar.running
    assert voice_handlers._active is None
    assert (await call(_Session(), "voice.start"))["ok"] is True


async def test_late_prewarm_from_before_switch_off_keeps_the_re_enabled_sidecar(
    voice: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Prewarm A stalls in its blocking model check on the shared pool.
    entered, release = threading.Event(), threading.Event()
    calls = 0

    def model_info() -> dict:
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            release.wait(10)
        return {"present": True, "bytes": 1, "path": "m"}

    monkeypatch.setattr(stt_service, "model_info", model_info)
    session = _Session()
    a = asyncio.create_task(call(session, "voice.prewarm"))
    assert await asyncio.to_thread(entered.wait, 10)
    assert await call(session, "voice.shutdown") == {"ok": True}
    # Switched back on: prewarm B loads the sidecar.
    assert await call(session, "voice.prewarm") == {"ok": True}
    assert stt_service.get_sidecar().running
    release.set()
    assert await asyncio.wait_for(a, 30) == {"ok": True}
    assert stt_service.get_sidecar().running
