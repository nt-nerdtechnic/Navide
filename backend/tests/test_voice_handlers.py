"""voice.* WebSocket handlers, end to end through app.handle_message with the
fake sidecar."""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import tempfile
import threading
import time
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


# ── Streaming partials (voice.partial) ──────────────────────────────────────
# FAKE_STT_DECODE makes the fake sidecar "hear" a run of sample 1000 + i as the
# character chr(0x4E00 + i), so hypotheses are exact. Each 250 ms block below is
# one character: 200 ms of tone, then a 50 ms pause.

BLOCK = SECOND // 4


@pytest.fixture
async def stream(voice: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    log_path = tmp_path / "requests.jsonl"
    monkeypatch.setenv("FAKE_STT_DECODE", "1")
    monkeypatch.setenv("FAKE_STT_LOG", str(log_path))
    monkeypatch.setattr(voice_handlers, "PARTIAL_INTERVAL_S", 0.05)
    yield log_path


def _requests(log_path: Path) -> list[dict]:
    if not log_path.exists():
        return []
    return [json.loads(line) for line in log_path.read_text(encoding="utf-8").splitlines()]


def _text(n: int) -> str:
    return "".join(chr(0x4E00 + i) for i in range(n))


async def _send(session: _Session, msg_type: str, payload: dict) -> dict:
    """Like call(), but tolerant of voice.partial events arriving meanwhile."""
    before = len(session.sent)
    await app_module.handle_message(session, {"id": "m", "type": msg_type, "payload": payload})  # type: ignore[arg-type]
    replies = [m for m in session.sent[before:] if m.get("type") == f"{msg_type}.result"]
    assert len(replies) == 1, session.sent[before:]
    return replies[0]["payload"]


async def _speak(session: _Session, sid: str, blocks: range, pause: float = 0.06) -> None:
    for i in blocks:
        tone = (1000 + i).to_bytes(2, "little", signed=True) * (BLOCK * 4 // 5 // 2)
        pcm = base64.b64encode(tone + bytes(BLOCK - len(tone))).decode()
        await app_module.handle_message(session, {  # type: ignore[arg-type]
            "id": "c", "type": "voice.chunk", "payload": {"sessionId": sid, "seq": i, "pcm": pcm},
        })
        await asyncio.sleep(pause)


async def _speak_in_step(session: _Session, sid: str, blocks: range, timeout: float = 5.0) -> None:
    """Like _speak, but each partial hears the same amount of new audio: two
    blocks (the least a partial waits for) go in, then nothing more until the
    partials have caught up. _speak's pace is wall-clock, so how much audio a
    partial takes in depends on the machine (and on Windows' 15.6 ms clock);
    the window size scales with it."""
    rec = voice_handlers._active
    assert rec is not None
    for i in blocks:
        await _speak(session, sid, range(i, i + 1), pause=0.0)
        if (i - blocks.start) % 2 == 0:
            continue
        deadline = time.monotonic() + timeout
        while voice_handlers._partial_due(rec) or (rec.partial is not None and not rec.partial.done()):
            assert time.monotonic() < deadline, "partials did not catch up"
            await asyncio.sleep(0.01)


def _partials(session: _Session) -> list[dict]:
    return [m["payload"] for m in session.sent if m.get("type") == "voice.partial"]


async def _settle(session: _Session, timeout: float = 5.0) -> None:
    """Wait until the in-flight partial (if any) has landed."""
    rec = voice_handlers._active
    if rec is not None and rec.partial is not None:
        await asyncio.wait_for(asyncio.shield(rec.partial), timeout)


async def test_partials_reach_only_the_owner_and_final_extends_committed(
    stream: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    broadcasts: list[dict] = []

    async def broadcast(msg: dict) -> None:
        broadcasts.append(msg)

    monkeypatch.setattr(app_module, "broadcast", broadcast)
    owner, other = _Session(), _Session()
    sid = (await _send(owner, "voice.start", {}))["sessionId"]
    await _speak(owner, sid, range(16))
    await asyncio.sleep(0.2)
    await _settle(owner)
    partials = _partials(owner)
    assert len(partials) >= 3
    assert all(p["sessionId"] == sid for p in partials)
    seqs = [p["seq"] for p in partials]
    assert seqs == sorted(set(seqs))
    committed = [p["committed"] for p in partials]
    assert all(b.startswith(a) for a, b in zip(committed, committed[1:]))
    assert committed[-1], "stable hypotheses must commit text"
    assert all(_text(16).startswith(p["committed"] + p["tentative"]) for p in partials)
    stop = await _send(owner, "voice.stop", {"sessionId": sid})
    assert stop["ok"] is True
    assert stop["text"] == _text(16) and stop["text"].startswith(committed[-1])
    assert other.sent == [] and not [b for b in broadcasts if b.get("type") == "voice.partial"]
    # Partials after the first carry the committed text as context.
    assert any((r["prompt"] or "").startswith(voice_handlers.DEFAULT_INITIAL_PROMPT) for r in _requests(stream))


async def test_script_is_forwarded_on_every_partial_and_the_final(stream: Path) -> None:
    session = _Session()
    sid = (await _send(session, "voice.start", {"script": "hant-tw"}))["sessionId"]
    await _speak(session, sid, range(16))
    await asyncio.sleep(0.2)
    await _settle(session)
    await _send(session, "voice.stop", {"sessionId": sid})
    *partials, final = _requests(stream)
    assert partials and all(r["segments"] for r in partials)
    assert {r["script"] for r in [*partials, final]} == {"hant-tw"}


@pytest.mark.parametrize("script", [None, "zh-CN", 3])
async def test_missing_or_unknown_script_sends_none(stream: Path, script: Any) -> None:
    session = _Session()
    payload = {} if script is None else {"script": script}
    sid = (await _send(session, "voice.start", payload))["sessionId"]
    await _speak(session, sid, range(4))
    await _send(session, "voice.stop", {"sessionId": sid})
    assert {r["script"] for r in _requests(stream)} == {None}


async def test_streaming_dedup_compares_converted_text(stream: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Every other run hears the "Simplified" forms; the sidecar converts them
    # all to Traditional, so the overlap still matches and no word repeats.
    monkeypatch.setenv("FAKE_STT_VARIANTS", "1")
    session = _Session()
    sid = (await _send(session, "voice.start", {"script": "hant-tw"}))["sessionId"]
    await _speak_in_step(session, sid, range(48))
    await asyncio.sleep(0.2)
    await _settle(session)
    assert voice_handlers._active.win_start > 0
    committed = [p["committed"] for p in _partials(session)]
    assert committed[-1] and all(_text(48).startswith(c) for c in committed)
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["text"] == _text(48)


async def test_unstable_tail_is_never_committed(stream: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_STT_TAIL_NOISE", "1")
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(12))
    await asyncio.sleep(0.2)
    await _settle(session)
    partials = _partials(session)
    assert partials and partials[-1]["committed"]
    assert not any(ch.isdigit() for p in partials for ch in p["committed"])
    assert any(p["tentative"][-1:].isdigit() for p in partials)
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    # The final pass keeps whatever the tail pass heard, noise digit included.
    assert stop["text"][:-1] == _text(12) and stop["text"][-1].isdigit()


async def test_window_advances_so_each_partial_stays_bounded(
    stream: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak_in_step(session, sid, range(48))  # 12 s of speech
    await asyncio.sleep(0.2)
    await _settle(session)
    assert voice_handlers._active.win_start > 0
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["text"] == _text(48)
    *partials, final = _requests(stream)
    partial_sizes = [r["bytes"] for r in partials]
    assert len(partial_sizes) >= 10
    # Agreed segments leave the window at once: it stays a few seconds long.
    assert max(partial_sizes) <= 4 * SECOND
    assert final["bytes"] <= 4 * SECOND + PAD


@pytest.mark.parametrize("skew_ms", [600, -600])
async def test_skewed_boundaries_neither_drop_nor_repeat_words(
    stream: Path, monkeypatch: pytest.MonkeyPatch, skew_ms: int,
) -> None:
    # Late boundaries used to cut off the start of the next clause (a drop);
    # early ones left the end of the committed clause in the next window (a
    # repeat). The overlap plus text dedup must give the exact text either way.
    monkeypatch.setenv("FAKE_STT_SKEW_MS", str(skew_ms))
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(48))
    await asyncio.sleep(0.2)
    await _settle(session)
    committed = [p["committed"] for p in _partials(session)]
    assert committed[-1] and voice_handlers._active.win_start > 0
    assert all(b.startswith(a) for a, b in zip(committed, committed[1:]))
    assert all(_text(48).startswith(c) for c in committed)
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["text"] == _text(48)


def test_unrecognised_overlap_is_held_not_committed_twice() -> None:
    # The window starts 1.5 s inside committed audio, and whisper hears that
    # overlap as other words (戊己庚), so the text dedup cannot strip it.
    rec = voice_handlers._Recording(id="x", owner=None)
    rec.committed, rec.committed_until = "甲乙丙丁,", SECOND * 3 // 2
    window = 5 * SECOND
    garbled = [
        {"t0_ms": 0, "t1_ms": 1200, "text": "戊己庚,"},
        {"t0_ms": 1200, "t1_ms": 3000, "text": "新的字,"},
        {"t0_ms": 3000, "t1_ms": 4200, "text": "尾巴"},
    ]
    for _ in range(2):  # two agreeing hypotheses would normally commit
        tentative = voice_handlers._apply_hypothesis(rec, garbled, window)
        assert rec.committed == "甲乙丙丁," and "戊己庚" not in tentative
    assert tentative == "新的字,尾巴"
    # Once a hypothesis re-hears the overlap, agreement commits again.
    # (It agrees with the held hypothesis, which already had the overlap cut.)
    heard = [{"t0_ms": 0, "t1_ms": 1200, "text": "乙丙丁,"}, *garbled[1:]]
    voice_handlers._apply_hypothesis(rec, heard, window)
    assert rec.committed == "甲乙丙丁,新的字,"


async def test_cancel_during_the_temp_write_leaves_no_audio(
    stream: Path, voice: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The cleanup (on the other pool worker) runs before the delayed write
    # opens the file; the write must not create it again.
    entered = threading.Event()
    write = voice_handlers._write_pcm

    def slow_write(path: Path, pcm: bytes) -> None:
        entered.set()
        time.sleep(0.3)
        write(path, pcm)

    monkeypatch.setattr(voice_handlers, "_write_pcm", slow_write)
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(8), pause=0.0)
    assert await asyncio.to_thread(entered.wait, 5)
    await _send(session, "voice.cancel", {"sessionId": sid})
    await asyncio.sleep(0.6)
    assert not list(voice.glob("navide-voice-*.pcm"))


def test_cleanup_during_the_temp_write_still_deletes_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Windows refuses to delete a file that is open (the write's descriptor
    # does not share delete access), so a cleanup landing mid-write must wait
    # for the write rather than fail and leave the audio on disk.
    path = tmp_path / "navide-voice-take.pcm"
    path.write_bytes(b"")
    open_paths: set[Path] = set()
    writing, release = threading.Event(), threading.Event()

    class _HeldFile:
        def __init__(self, fh: Any) -> None:
            self.fh = fh

        def __enter__(self) -> _HeldFile:
            open_paths.add(path)
            return self

        def __exit__(self, *exc: object) -> None:
            self.fh.close()
            open_paths.discard(path)

        def write(self, data: bytes) -> None:
            writing.set()
            release.wait(5)
            self.fh.write(data)

    real_fdopen, real_unlink = voice_handlers.os.fdopen, Path.unlink

    def unlink(self: Path, missing_ok: bool = False) -> None:
        if self in open_paths:
            raise PermissionError(13, "The process cannot access the file because it is being used by another process")
        real_unlink(self, missing_ok)

    monkeypatch.setattr(voice_handlers.os, "fdopen", lambda fd, mode: _HeldFile(real_fdopen(fd, mode)))
    monkeypatch.setattr(Path, "unlink", unlink)
    writer = threading.Thread(target=voice_handlers._write_pcm, args=(path, b"\x01\x02"))
    writer.start()
    assert writing.wait(5)
    cleaner = threading.Thread(target=voice_handlers._remove, args=(path,))
    cleaner.start()
    cleaner.join(0.2)
    release.set()
    writer.join(5)
    cleaner.join(5)
    assert not path.exists()


def test_strip_overlap() -> None:
    def strip(done: str, texts: list[str]) -> list[str]:
        return voice_handlers._strip_overlap(done, texts)[0]

    assert strip("我們一直打字,接著,", ["打字,接著,我們", "再說"]) == ["我們", "再說"]
    assert strip("我們一直打字,接著,", ["著", "直打字,接著,我們"]) == ["", "我們"]  # clipped word
    assert strip("最後,", ["最後,", "當你放開按鍵,"]) == ["", "當你放開按鍵,"]
    assert strip("最後,", ["當你放開按鍵,"]) == ["當你放開按鍵,"]
    assert strip("今天天氣不錯", ["天汽不錯,我們"]) == ["我們"]  # a misheard character
    assert strip("今天天氣真的不錯", ["天氣不錯,我們"]) == ["我們"]  # a dropped one
    assert strip("run the tests", [" the tests now"]) == ["now"]
    assert strip("", ["abc"]) == ["abc"]
    assert voice_handlers._strip_overlap("最後,", ["當你放開按鍵,"])[1] is False


async def test_force_trim_when_no_agreement_at_cap(stream: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # Every segment ends in a digit that changes per request, so no two
    # hypotheses agree: only the cap moves the window.
    monkeypatch.setenv("FAKE_STT_TAIL_NOISE", "all")
    monkeypatch.setattr(voice_handlers, "WINDOW_CAP_BYTES", 3 * SECOND)
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(40))
    await asyncio.sleep(0.2)
    await _settle(session)
    assert max(r["bytes"] for r in _requests(stream) if r["segments"]) <= 4 * SECOND
    committed = [p["committed"] for p in _partials(session)]
    assert all(b.startswith(a) for a, b in zip(committed, committed[1:]))
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["text"].startswith(committed[-1])
    # Per-segment random digits also defeat the overlap dedup (real whisper
    # does not scatter noise like that), so only require that nothing was
    # lost: every character, in order.
    heard = iter(stop["text"])
    assert all(ch in heard for ch in _text(40)), stop["text"]


async def test_busy_partials_are_skipped_not_queued(stream: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FAKE_STT_DELAY_S", "0.3")
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(20))  # ~1.2 s at 20 ticks/s
    await _settle(session)
    requests = [r for r in _requests(stream) if r["segments"]]
    assert 1 <= len(requests) <= 6
    # Serial, one at a time: no request started before the previous ended.
    assert all(b["start"] >= a["end"] for a, b in zip(requests, requests[1:]))
    await _send(session, "voice.cancel", {"sessionId": sid})


async def test_stop_cancels_an_in_flight_partial_then_runs_the_tail(
    stream: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_STT_DELAY_S", "0.6")
    # Written by the sidecar once it has read the partial's audio. Stopping any
    # earlier (the request merely written to its stdin) lets the cancelled
    # partial's audio be deleted before the sidecar reads it: no partial runs
    # at all, and there is nothing in flight for stop to cancel.
    started_path = stream.with_name("started.txt")
    monkeypatch.setenv("FAKE_STT_STARTED", str(started_path))
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(8), pause=0.0)
    deadline = time.monotonic() + 30
    while not (started_path.exists() and started_path.read_text(encoding="utf-8").strip()):
        if time.monotonic() > deadline:
            pytest.fail("no partial started")
        await asyncio.sleep(0.01)
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["ok"] is True and stop["text"] == _text(8)
    partial, final = _requests(stream)
    assert partial["cancelled"] and not final["cancelled"]
    # The partial was cut short rather than waited out, then the tail ran.
    # Timed by the sidecar's own clock, so a loaded machine cannot fail it.
    assert partial["end"] - partial["start"] < 0.6, partial
    assert final["start"] >= partial["end"] and final["end"] - final["start"] >= 0.6, final
    await asyncio.sleep(0.1)
    assert _partials(session) == []


async def test_cancel_aborts_the_in_flight_partial_and_leaves_no_audio(
    stream: Path, voice: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_STT_DELAY_S", "5")
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(8), pause=0.0)
    for _ in range(200):
        if stt_service.get_sidecar()._pending:
            break
        await asyncio.sleep(0.01)
    else:
        pytest.fail("no partial started")
    partial = voice_handlers._active.partial
    await _send(session, "voice.cancel", {"sessionId": sid})
    with pytest.raises(asyncio.CancelledError):
        await partial
    # The sidecar aborted it (a ping answers at once) and the temp file is gone.
    assert (await asyncio.wait_for(stt_service.get_sidecar().ping(), 2))["ok"] is True
    await asyncio.sleep(0.1)
    assert not list(voice.glob("navide-voice-*.pcm"))


async def test_switch_off_ends_partials(stream: Path) -> None:
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    await _speak(session, sid, range(8))
    rec = voice_handlers._active
    assert rec.ticker is not None
    await _send(session, "voice.shutdown", {})
    count = len(_partials(session))
    await asyncio.sleep(0.3)
    assert rec.ticker is None and voice_handlers._active is None
    assert len(_partials(session)) == count


async def test_no_partials_for_a_silent_mic(stream: Path) -> None:
    session = _Session()
    sid = (await _send(session, "voice.start", {}))["sessionId"]
    frame = (0).to_bytes(2, "little", signed=True)
    for i in range(8):
        pcm = base64.b64encode(frame * (BLOCK // 2)).decode()
        await app_module.handle_message(session, {  # type: ignore[arg-type]
            "id": "c", "type": "voice.chunk", "payload": {"sessionId": sid, "seq": i, "pcm": pcm},
        })
        await asyncio.sleep(0.06)
    assert _requests(stream) == [] and _partials(session) == []
    stop = await _send(session, "voice.stop", {"sessionId": sid})
    assert stop["text"] == "" and stop["peak"] == 0


def test_join_restores_the_space_between_latin_words() -> None:
    assert voice_handlers._join("hello", "world") == "hello world"
    assert voice_handlers._join("hello.", "World") == "hello. World"
    assert voice_handlers._join("你好，", "world") == "你好，world"
    assert voice_handlers._join("你好", "世界") == "你好世界"
