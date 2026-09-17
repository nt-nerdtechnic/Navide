"""CLIProxyAPI (router-for-me/CLIProxyAPI) — a background proxy server, not a
coding agent: it multiplexes several providers' OAuth accounts (Claude, Codex,
Antigravity, Kimi, xAI, Devin, Meta) behind one OpenAI/Gemini/Claude-compatible
endpoint and round-robins across whichever accounts are loaded.

That shape does not fit the account-slot model the other vendors use: they
each represent ONE signed-in identity you switch between, but CLIProxyAPI
holds MANY accounts loaded at once under its own auths directory
(``~/.cli-proxy-api`` by default) and serves them all simultaneously — there
is no single "current" identity for a Navide profile to park or restore.
Trying to model that as a switchable slot would misrepresent what signing
another account in or out actually does (it changes the server's pool, not an
active identity).

So this vendor is deliberately narrow: it registers CLIProxyAPI as a
launchable/installable CLI (default command runs its own interactive `--tui`
management console, verified in cmd/server/main.go to start an embedded
server and connect a TUI client to it) and nothing else. No credential
parking, no resume, no log reading — all left at their defaults, which the
app treats as "unsupported for this vendor" rather than a missing feature.
"""

from .base import Dep, VendorSpec

SPEC = VendorSpec(
    key="cliproxyapi",
    label="CLIProxyAPI",
    # No live_file/slot_file/session fields: see module docstring — its
    # multi-account pool has no single identity for the vault to hold.
    # `--tui` (the default command) has no conversation to name and resume.
    supports_session_resume=False,
    install_dep=Dep(
        "cliproxyapi",
        "CLIProxyAPI",
        "Multi-provider AI proxy (Claude/Codex/Antigravity/Kimi/xAI accounts "
        "behind one OpenAI-compatible endpoint)",
        "agent_cli",
        ["CLIProxyAPI", "--help"],
        # The version banner prints unconditionally before flag parsing (see
        # cmd/server/main.go), so it survives --help's exit even though
        # --help itself is not one of the binary's declared flags.
        r"CLIProxyAPI Version:\s*(\S+),",
        optional=True,
        docs_url="https://github.com/router-for-me/CLIProxyAPI",
    ),
)
