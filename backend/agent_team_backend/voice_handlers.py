"""WebSocket side of push-to-talk voice input (``voice.*``).

Handlers are registered in ws_handlers. One recording at a time: a window
streams base64 s16le mono 16 kHz PCM with ``voice.chunk`` between
``voice.start`` and ``voice.stop``; stop writes the audio to a temp file, asks
the sidecar to transcribe it and deletes the file. Nothing here runs until a
``voice.*`` message arrives.
"""

from __future__ import annotations

import array
import asyncio
import base64
import binascii
import contextlib
import logging
import math
import operator
import os
import sys
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import stt_service
from .ipc import make_event, make_response

if TYPE_CHECKING:
    from .app import Session

log = logging.getLogger(__name__)

_BYTES_PER_SECOND = 16_000 * 2
# Hands-free (locked / toggle) takes run up to 5 minutes; hold-to-talk stops
# itself at 60 s in the window.
MAX_PCM_BYTES = _BYTES_PER_SECOND * 300
MIN_PCM_BYTES = int(_BYTES_PER_SECOND * 0.3)
# Whole-take s16 peak below this is a mic that delivered (near-)digital
# silence — a denied/misattributed TCC grant or a dead device — not a quiet
# speaker. ~NT-type's RMS < 0.002 of full scale (pipeline.rs SILENCE_PEAK).
SILENT_PEAK = 64
# Zeros appended before transcription: Whisper clips the last word of audio
# that ends mid-syllable.
_TAIL_PAD_BYTES = _BYTES_PER_SECOND // 2
# A recording whose window stopped talking to us (crashed mid-press) must not
# hold the recorder forever: past the 5 min cap plus slack it is abandoned.
_STALE_AFTER_S = 330.0
DEFAULT_LANGUAGE = "zh"


@dataclass
class _Recording:
    id: str
    owner: Any
    chunks: dict[int, bytes] = field(default_factory=dict)
    size: int = 0
    # Level stats, folded in per chunk so stop does not rescan minutes of audio.
    peak: int = 0
    sum_sq: int = 0
    touched: float = field(default_factory=time.monotonic)

    def stale(self) -> bool:
        return bool(getattr(self.owner, "dead", False)) or time.monotonic() - self.touched > _STALE_AFTER_S


_active: _Recording | None = None
_download_task: asyncio.Task | None = None
# Set by voice.shutdown (voice input switched off), cleared by every prewarm
# and start. A prewarm or start still awaiting when the switch-off ran finds it
# set after its spawn and stops the sidecar again, instead of leaving it loaded
# for the idle timeout. A later prewarm/start (switched back on) clears it, so a
# late answer from before the switch-off never stops a sidecar that is wanted.
_disabled = False


async def _switched_off() -> bool:
    """True (and the sidecar stopped) if voice input is switched off."""
    if not _disabled:
        return False
    sidecar = stt_service.peek_sidecar()
    if sidecar is not None:
        await sidecar.stop()
    return True


def _take(session: Any, session_id: Any) -> _Recording | None:
    """Detach the active recording if ``session`` owns ``session_id``."""
    global _active
    rec = _active
    if rec is None or rec.id != session_id or rec.owner is not session:
        return None
    _active = None
    return rec


def drop_owner(session: Any) -> None:
    """A window disconnected: abandon its recording."""
    global _active
    if _active is not None and _active.owner is session:
        _active = None


async def _reply(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    await session.send_json(make_response(msg_id, msg_type, payload))


async def voice_status(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    sidecar = stt_service.peek_sidecar()
    binary = await stt_service.run_blocking(stt_service.sidecar_path)
    await _reply(session, msg_id, msg_type, {
        "ok": True,
        "sidecar": "ok" if binary is not None else "missing",
        "model": await stt_service.run_blocking(stt_service.model_info),
        "running": bool(sidecar and sidecar.running),
        "gpu": sidecar.gpu if sidecar is not None else None,
    })


async def voice_prewarm(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Load the sidecar ahead of the first press. Claims no recording."""
    global _disabled
    _disabled = False
    if await stt_service.run_blocking(stt_service.sidecar_path) is None:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-missing"})
        return
    if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "model-missing"})
        return
    try:
        await stt_service.get_sidecar().ensure_started()
    except stt_service.SidecarError as err:
        log.warning("voice.prewarm: sidecar failed: %s", err)
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-failed"})
        return
    if await _switched_off():
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "disabled"})
        return
    await _reply(session, msg_id, msg_type, {"ok": True})


async def voice_shutdown(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Voice input was switched off: drop any recording and stop the sidecar."""
    global _active, _disabled
    _disabled = True
    _active = None
    sidecar = stt_service.peek_sidecar()
    if sidecar is not None:
        await sidecar.stop()
    await _reply(session, msg_id, msg_type, {"ok": True})


async def _broadcast_progress(data: dict) -> None:
    from . import app

    await app.broadcast(make_event("voice.model.progress", data))


async def _run_download() -> None:
    total = stt_service.MODEL_BYTES
    done = 0

    async def progress(bytes_done: int, bytes_total: int) -> None:
        nonlocal done, total
        done, total = bytes_done, bytes_total
        await _broadcast_progress({"bytes": bytes_done, "total": bytes_total, "done": False})

    try:
        if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
            await stt_service.download_model(progress)
    except asyncio.CancelledError:
        raise
    except Exception as err:  # noqa: BLE001
        log.warning("voice model download failed: %s", err)
        # done=True marks the end of the attempt; error says it failed.
        await _broadcast_progress({"bytes": done, "total": total, "done": True, "error": str(err)})
        return
    size = stt_service.MODEL_BYTES
    await _broadcast_progress({"bytes": size, "total": size, "done": True})


async def voice_model_download(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """Answer at once; progress reaches every window as voice.model.progress."""
    global _download_task
    if _download_task is None or _download_task.done():
        _download_task = asyncio.create_task(_run_download())
    await _reply(session, msg_id, msg_type, {"ok": True})


async def voice_start(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    global _active, _disabled
    _disabled = False
    if await stt_service.run_blocking(stt_service.sidecar_path) is None:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-missing"})
        return
    if not (await stt_service.run_blocking(stt_service.model_info))["present"]:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "model-missing"})
        return
    # A window runs one take at a time, so its own earlier claim (a start it
    # gave up on while the sidecar was still loading) is superseded, not busy.
    if _active is not None and _active.owner is not session and not _active.stale():
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "busy"})
        return
    rec = _Recording(id=uuid.uuid4().hex, owner=session)
    _active = rec  # claimed before the (possibly slow) spawn so a second start is busy
    try:
        await stt_service.get_sidecar().ensure_started()
    except stt_service.SidecarError as err:
        log.warning("voice.start: sidecar failed: %s", err)
        if _active is rec:
            _active = None
        reason = "sidecar-missing" if str(err) == "sidecar-missing" else "sidecar-failed"
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": reason})
        return
    if await _switched_off():
        if _active is rec:
            _active = None
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "disabled"})
        return
    rec.touched = time.monotonic()
    await _reply(session, msg_id, msg_type, {"ok": True, "sessionId": rec.id})


async def voice_chunk(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    """No reply. Chunks past the 5 min cap, duplicates and bad frames are dropped."""
    rec = _active
    if rec is None or rec.owner is not session or payload.get("sessionId") != rec.id:
        return
    rec.touched = time.monotonic()
    try:
        data = base64.b64decode(str(payload.get("pcm") or ""), validate=True)
    except (binascii.Error, ValueError):
        return
    seq = payload.get("seq")
    if isinstance(seq, bool) or not isinstance(seq, int):
        seq = max(rec.chunks, default=-1) + 1
    if seq in rec.chunks or not data:
        return
    room = MAX_PCM_BYTES - rec.size
    if room <= 0:
        return
    data = data[: room - (room % 2)] if len(data) > room else data
    rec.chunks[seq] = data
    rec.size += len(data)
    peak, sum_sq = _levels(data)
    rec.peak = max(rec.peak, peak)
    rec.sum_sq += sum_sq


def _levels(pcm: bytes) -> tuple[int, int]:
    """Peak and sum of squares of s16le audio."""
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - len(pcm) % 2])
    if sys.byteorder == "big":
        samples.byteswap()
    if not samples:
        return 0, 0
    return max(max(samples), -min(samples)), sum(map(operator.mul, samples, samples))


def _write_temp_pcm(pcm: bytes) -> Path:
    fd, name = tempfile.mkstemp(prefix="navide-voice-", suffix=".pcm")
    with os.fdopen(fd, "wb") as fh:
        fh.write(pcm)
    return Path(name)


def _remove(path: Path) -> None:
    with contextlib.suppress(OSError):
        path.unlink()


async def voice_stop(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    rec = _take(session, payload.get("sessionId"))
    if rec is None:
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "no-session"})
        return
    pcm = b"".join(rec.chunks[seq] for seq in sorted(rec.chunks))
    duration_ms = len(pcm) * 1000 // _BYTES_PER_SECOND
    peak = rec.peak
    rms = math.sqrt(rec.sum_sq / (len(pcm) // 2)) if len(pcm) >= 2 else 0.0
    log.info(
        "voice.stop duration_ms=%d chunks=%d bytes=%d peak=%d rms=%.1f",
        duration_ms, len(rec.chunks), len(pcm), peak, rms,
    )
    # Too short to hold a word, or silence from the device: nothing to
    # transcribe. The window tells the two apart from durationMs and peak.
    if len(pcm) < MIN_PCM_BYTES or peak < SILENT_PEAK:
        await _reply(session, msg_id, msg_type, {
            "ok": True, "text": "", "ms": 0, "durationMs": duration_ms, "peak": peak,
        })
        return
    pcm += bytes(_TAIL_PAD_BYTES)
    language = payload.get("language")
    language = language if isinstance(language, str) and language else DEFAULT_LANGUAGE
    prompt = payload.get("initialPrompt")
    prompt = prompt if isinstance(prompt, str) and prompt else None
    path = await stt_service.run_blocking(_write_temp_pcm, pcm)
    try:
        result = await stt_service.get_sidecar().transcribe(path, language, prompt)
    except stt_service.SidecarError as err:
        log.warning("voice.stop: sidecar failed: %s", err)
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "sidecar-failed"})
        return
    finally:
        await stt_service.run_blocking(_remove, path)
    if not result.get("ok"):
        log.warning("voice.stop: transcription failed: %s", result.get("error"))
        await _reply(session, msg_id, msg_type, {"ok": False, "reason": "transcribe-failed"})
        return
    await _reply(session, msg_id, msg_type, {
        "ok": True,
        "text": str(result.get("text") or ""),
        "ms": int(result.get("ms") or 0),
        "durationMs": duration_ms,
        "peak": peak,
    })


async def voice_cancel(session: "Session", msg_id: str, msg_type: str, payload: dict) -> None:
    _take(session, payload.get("sessionId"))
    await _reply(session, msg_id, msg_type, {"ok": True})


async def shutdown() -> None:
    """Backend exit: stop any download and the sidecar."""
    global _active, _download_task
    _active = None
    task, _download_task = _download_task, None
    if task is not None and not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
    await stt_service.shutdown()
