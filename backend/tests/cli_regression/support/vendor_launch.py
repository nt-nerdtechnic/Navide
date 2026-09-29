"""External launch observer. It never loads vendor packages or credentials."""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys


def main():
    vendor, destination, *arguments = sys.argv[1:]
    if "--version" in arguments:
        print("99.0.0-regression" if vendor == "cursor" else f"{vendor} 99.0.0-regression")
        return
    # Only intentionally synthetic environment values are recorded. Actual
    # paths are reduced to equality flags; no auth/key environment is read.
    request_keys = json.loads(os.environ.get("REGRESSION_GUARDED_KEYS", "[]"))
    Path(destination).write_text(json.dumps({
        "argv": arguments,
        "marker": os.environ.get("REGRESSION_MARKER"),
        "esc_timeout": os.environ.get("PI_TUI_ESC_TIMEOUT"),
        "leaked_overrides": [key for key in request_keys if os.environ.get(key)
                             in {"fixture-inherited-home", "fixture-requested-home"}],
        "minimax_relocated": any(os.environ.get(key) for key in ("MINIMAX_DATA_DIR", "MAVIS_DATA_DIR")),
    }), encoding="utf-8")
    print("VENDOR_LAUNCH_READY", flush=True)
    for line in sys.stdin:
        if line.strip() == "exit":
            return


if __name__ == "__main__":
    main()
