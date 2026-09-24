"""Stand-in for the navide-stt sidecar, speaking its JSON Lines protocol.

FAKE_STT_MODE: "ok" (default), "fatal" (fatal instead of ready), "silent"
(never prints ready). A request with op "crash" makes it exit abruptly.
Transcription answers ``bytes=<file size> lang=<language> prompt=<prompt>``.
"""

import json
import os
import sys


def send(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> int:
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
    for line in sys.stdin:
        req = json.loads(line)
        op = req.get("op")
        if op == "shutdown":
            return 0
        if op == "crash":
            os._exit(3)
        if op == "ping":
            send({"id": req["id"], "ok": True})
        elif op == "transcribe":
            try:
                size = os.path.getsize(req["pcm_path"])
            except OSError as err:
                send({"id": req["id"], "ok": False, "error": str(err)})
                continue
            text = f"bytes={size} lang={req.get('language')} prompt={req.get('initial_prompt', '-')}"
            send({"id": req["id"], "ok": True, "text": text, "ms": 5})
        else:
            send({"id": req.get("id"), "ok": False, "error": f"unknown op {op}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
