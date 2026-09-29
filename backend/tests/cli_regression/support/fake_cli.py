"""Synthetic external CLI: deterministic line protocol over a real PTY."""
from __future__ import annotations

import json
import os
import sys
import threading


def main() -> None:
    print("READY " + json.dumps({"pid": os.getpid()}), flush=True)
    flooding = threading.Event()
    worker = None

    def flood() -> None:
        # Bounded output, with a concurrent stdin consumer so input during
        # output saturation can stop the producer without a timer race.
        for _ in range(512):
            if not flooding.is_set():
                break
            print("FLOOD " + "x" * 2048, flush=True)
        print("FLOOD_DONE", flush=True)

    for raw in sys.stdin:
        line = raw.strip()
        if line == "exit":
            flooding.clear()
            if worker:
                worker.join()
            print("EXITING", flush=True)
            return
        if line == "flood":
            flooding.set()
            worker = threading.Thread(target=flood)
            worker.start()
        else:
            flooding.clear()
            print("ACK " + json.dumps({"pid": os.getpid(), "text": line}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
