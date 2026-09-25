"""Stand-in for the navide-stt sidecar, speaking its JSON Lines protocol.

FAKE_STT_MODE: "ok" (default), "fatal" (fatal instead of ready), "silent"
(never prints ready). A request with op "crash" makes it exit abruptly.
Transcription answers ``bytes=<file size> lang=<language> prompt=<prompt>``.

With FAKE_STT_DECODE=1 it "hears" the audio instead: every run of 10 ms
frames starting with the same sample v (|v| >= 64) is the character
chr(0x4E00 + v % 1000); quieter frames are silence. Characters form one
segment per four, timed by where their runs sit in the audio, so windowed and
streaming callers get stable, checkable text wherever a window starts.
FAKE_STT_TAIL_NOISE=1 appends a digit that changes on every request to the
last segment (an unstable last word), =all to every segment; FAKE_STT_SKEW_MS moves every
boundary between two segments by that many ms (late if positive, early if
negative), like whisper's approximate token timestamps; FAKE_STT_DELAY_S sleeps before answering (a
``{"op":"cancel","target":id}`` cuts that short, like the real sidecar);
FAKE_STT_LOG names a file that gets one JSON line per transcribe request.
FAKE_STT_STARTED names a file that gets the request id once the audio has
been read and the request is running (before FAKE_STT_DELAY_S), so a test
can wait for a request to be truly in flight.
FAKE_STT_HOLD_S keeps the audio file open that long after reading it, the way
a Windows scanner or indexer can; while it is open a ``<pcm_path>.held``
sibling exists, so a test can refuse to delete it as Windows would.
FAKE_STT_VARIANTS=1 hears every character of odd-numbered requests as its
"Simplified" variant chr(0x5E00 + v % 1000), like whisper switching script
between runs; a request with ``script`` "hant-tw" converts those back to the
0x4E00 forms, as the real sidecar converts to Traditional.
"""

import json
import os
import queue
import struct
import sys
import threading
import time

def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


_FRAME = 320  # 10 ms of s16le mono 16 kHz
_TAIL_MS = 50  # silence counted into a segment after its last character


def _to_hant(text: str) -> str:
    return "".join(chr(ord(c) - 0x1000) if 0x5E00 <= ord(c) < 0x5E00 + 1000 else c for c in text)


def decode(
    data: bytes, noise: int | None, noise_all: bool = False, skew: int = 0, variant: bool = False,
) -> tuple[str, list[dict]]:
    runs: list[list[int]] = []  # [value, first frame, frame count]
    for frame in range(len(data) // _FRAME):
        (value,) = struct.unpack_from("<h", data, frame * _FRAME)
        if abs(value) < 64:
            continue
        if runs and runs[-1][0] == value and runs[-1][1] + runs[-1][2] == frame:
            runs[-1][2] += 1
        else:
            runs.append([value, frame, 1])
    end_ms = len(data) // _FRAME * 10
    segments: list[dict] = []
    for value, first, count in runs:
        if count < 5:
            continue  # a sliver of a sound, not a character
        char = chr((0x5E00 if variant else 0x4E00) + value % 1000)
        t0, t1 = first * 10, min((first + count) * 10 + _TAIL_MS, end_ms)
        if segments and len(segments[-1]["text"]) < 4:
            segments[-1]["text"] += char
            segments[-1]["t1_ms"] = t1
        else:
            segments.append({"t0_ms": t0, "t1_ms": t1, "text": char})
    for seg, nxt in zip(segments, segments[1:]):
        boundary = min(max(seg["t1_ms"] + skew, seg["t0_ms"]), nxt["t1_ms"])
        seg["t1_ms"] = nxt["t0_ms"] = boundary
    if noise is not None:
        for seg in segments if noise_all else segments[-1:]:
            seg["text"] += str(noise % 10)
    return "".join(seg["text"] for seg in segments), segments


def main() -> int:
    # The real sidecar speaks UTF-8 on its pipes; Python would use the locale
    # encoding there (cp1252 on Windows), which cannot write the decoded text.
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    model = sys.argv[sys.argv.index("--model") + 1]
    mode = os.environ.get("FAKE_STT_MODE", "ok")
    print("fake sidecar starting", file=sys.stderr, flush=True)
    if mode == "fatal":
        send({"event": "fatal", "error": "model load failed"})
        return 1
    if mode == "silent":
        sys.stdin.read()
        return 0
    send({"event": "ready", "version": "0.1.0", "model": model, "gpu": False})
    decoding = os.environ.get("FAKE_STT_DECODE") == "1"
    tail_noise = os.environ.get("FAKE_STT_TAIL_NOISE") or ""
    delay = float(os.environ.get("FAKE_STT_DELAY_S") or 0)
    hold = float(os.environ.get("FAKE_STT_HOLD_S") or 0)
    skew = int(os.environ.get("FAKE_STT_SKEW_MS") or 0)
    variants = os.environ.get("FAKE_STT_VARIANTS") == "1"
    log_path = os.environ.get("FAKE_STT_LOG")
    started_path = os.environ.get("FAKE_STT_STARTED")
    requests = 0
    # stdin is read on its own thread so a cancel reaches a request that is
    # already "running" (sleeping out its delay).
    inbox: queue.Queue = queue.Queue()
    cancelled: set = set()

    def read() -> None:
        for line in sys.stdin:
            req = json.loads(line)
            if req.get("op") == "cancel":
                cancelled.add(req.get("target"))
            else:
                inbox.put(req)
        inbox.put({"op": "shutdown"})

    threading.Thread(target=read, daemon=True).start()
    while True:
        req = inbox.get()
        op = req.get("op")
        if op == "shutdown":
            return 0
        if op == "crash":
            os._exit(3)
        if op == "ping":
            send({"id": req["id"], "ok": True})
        elif op == "transcribe":
            try:
                # Read up front, as the real sidecar does: the caller may
                # delete the file once it has cancelled the request.
                held = req["pcm_path"] + ".held"
                open(held, "wb").close()
                try:
                    with open(req["pcm_path"], "rb") as fh:
                        data = fh.read()
                        time.sleep(hold)
                finally:
                    os.remove(held)
                size = len(data)
            except OSError as err:
                send({"id": req["id"], "ok": False, "error": str(err)})
                continue
            requests += 1
            started = time.monotonic()
            if started_path:
                with open(started_path, "a", encoding="utf-8") as fh:
                    fh.write(req["id"] + "\n")
            while time.monotonic() - started < delay and req["id"] not in cancelled:
                time.sleep(0.005)
            was_cancelled = req["id"] in cancelled
            if log_path:
                with open(log_path, "a", encoding="utf-8") as fh:
                    fh.write(json.dumps({
                        "bytes": size, "segments": bool(req.get("segments")), "cancelled": was_cancelled,
                        "prompt": req.get("initial_prompt"), "script": req.get("script"), "start": started, "end": time.monotonic(),
                    }, ensure_ascii=False) + "\n")
            if was_cancelled:
                send({"id": req["id"], "ok": False, "error": "cancelled", "cancelled": True})
                continue
            if not decoding:
                text = f"bytes={size} lang={req.get('language')} prompt={req.get('initial_prompt', '-')}"
                if "script" in req:
                    text += f" script={req['script']}"
                send({"id": req["id"], "ok": True, "text": text, "ms": 5})
                continue
            text, segments = decode(
                data, requests if tail_noise else None, tail_noise == "all", skew, variants and requests % 2 == 1,
            )
            if req.get("script") == "hant-tw":
                text = _to_hant(text)
                for seg in segments:
                    seg["text"] = _to_hant(seg["text"])
            reply = {"id": req["id"], "ok": True, "text": text, "ms": 5}
            if req.get("segments"):
                reply["segments"] = segments
            send(reply)
        else:
            send({"id": req.get("id"), "ok": False, "error": f"unknown op {op}"})


if __name__ == "__main__":
    sys.exit(main())
