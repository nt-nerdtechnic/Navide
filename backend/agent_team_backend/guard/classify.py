"""Static danger classification of a CLI tool call.

Deterministic string/path analysis only — never an LLM (an LLM judge would be
injectable) and never a filesystem or network lookup (this runs inside a
synchronous PreToolUse hook, so it must stay in the millisecond range).

The first version is deliberately narrow: "critical" holds only a handful of
unambiguous patterns, because false positives are what make users switch a
guard off. Everything a pattern does not name is "normal".

``parseable=False`` means the command cannot be judged statically (eval,
variable expansion in a command word or in the target of a destructive op,
``base64 -d | sh``, executing a downloaded or unknown script, interpreter
``-c`` code). The policy layer treats that as "high" for tainted panes.
"""

from __future__ import annotations

import fnmatch
import os
import posixpath
import re
import shlex
from dataclasses import dataclass, field

from .. import osplat

LEVEL_ORDER = {"normal": 0, "high": 1, "critical": 2}

SHELL_TOOLS = {
    "shell", "bash", "exec", "exec_command", "local_shell", "run_shell_command",
    "shell_command", "run_command", "terminal", "powershell",
}
WRITE_TOOLS = {
    "write", "edit", "multiedit", "notebookedit", "write_file", "edit_file",
    "replace", "apply_patch", "str_replace_editor", "create",
}
READ_TOOLS = {"read", "read_file", "view", "cat", "notebookread"}

WRAPPERS_NO_ARG = {"nohup", "time", "command", "builtin", "exec", "caffeinate", "stdbuf"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"}
INTERPRETERS = SHELLS | {
    "python", "python2", "python3", "perl", "ruby", "node", "php", "osascript",
    "deno", "bun", "pwsh",
}
DOWNLOADERS = {"curl", "wget", "fetch", "http", "https", "aria2c"}
DECODERS = {"base64", "base32", "xxd", "openssl", "gunzip", "zcat", "uudecode"}
LIST_ONLY = {"ls", "stat", "test", "[", "[[", "file", "du", "exa", "eza", "tree"}
NON_PATH_CMDS = {"echo", "printf", "true", "false", ":", "export", "unset", "alias"}
LEADING_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "fi", "done"}
SKIP_SEGMENT_KEYWORDS = {"for", "case", "esac", "select", "function"}
PUBLISH = {
    ("npm", "publish"), ("pnpm", "publish"), ("yarn", "publish"), ("twine", "upload"),
    ("uv", "publish"), ("poetry", "publish"), ("cargo", "publish"), ("gem", "push"),
    ("flit", "publish"), ("hatch", "publish"),
}
PROTECTED_BRANCHES = {"main", "master"}
SYSTEM_BIN_PREFIXES = (
    "/usr/", "/bin/", "/sbin/", "/opt/homebrew/", "/opt/local/", "/Applications/",
    "/System/", "/Library/", "/nix/",
)
_TEMP_ROOTS = ("/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders")
_GLOB_CHARS = set("*?[")
# Every path is compared in one canonical form: '/'-separated and, on
# Windows, drive-lettered and case-folded (NTFS is case-insensitive).
_WINDOWS = osplat.platform_id == "win32"
_DRIVE_RE = re.compile(r"^[A-Za-z]:")
_MSYS_DRIVE_RE = re.compile(r"^/([A-Za-z])(?=/|$)")  # Git Bash's /c/Users/...
_HOME_TOKENS = ("${HOME}", "$HOME", "${env:USERPROFILE}", "$env:USERPROFILE", "$USERPROFILE", "%USERPROFILE%")
_PLACEHOLDER = "\x00SUBST"


@dataclass(frozen=True)
class Verdict:
    level: str
    rule_ids: tuple[str, ...]
    reasons: tuple[str, ...]
    parseable: bool


@dataclass
class _Acc:
    level: str = "normal"
    rules: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    parseable: bool = True

    def hit(self, level: str, rule: str, reason: str) -> None:
        if LEVEL_ORDER[level] > LEVEL_ORDER[self.level]:
            self.level = level
        if rule not in self.rules:
            self.rules.append(rule)
            self.reasons.append(reason)

    def opaque(self, rule: str, reason: str) -> None:
        self.parseable = False
        if rule not in self.rules:
            self.rules.append(rule)
            self.reasons.append(reason)

    def verdict(self) -> Verdict:
        return Verdict(self.level, tuple(self.rules), tuple(self.reasons), self.parseable)


@dataclass
class _Ctx:
    cwd: str
    workspace: str
    home: str
    downloaded: set[str] = field(default_factory=set)


# ---------------------------------------------------------------- paths


def _norm(path: str) -> str:
    if not path:
        return path
    if not _WINDOWS:
        return posixpath.normpath(path)
    p = path.replace("\\", "/")
    m = _MSYS_DRIVE_RE.match(p)
    if m:
        p = m.group(1) + ":" + p[2:]
    if _DRIVE_RE.match(p):
        p = p[:2] + posixpath.normpath("/" + p[2:].lstrip("/"))
    else:
        p = posixpath.normpath(p)
    return p.lower()


def _isabs(path: str) -> bool:
    return path.startswith("/") or (_WINDOWS and bool(_DRIVE_RE.match(path)))


def _home() -> str:
    return _norm(os.path.expanduser("~"))


def _resolve(arg: str, ctx: _Ctx) -> str | None:
    """Absolute normalized path for an argument, or None when it cannot be
    known statically (variable other than HOME, command substitution)."""
    if _PLACEHOLDER in arg:
        return None
    p = arg.replace("\\", "/") if _WINDOWS else arg
    for token in _HOME_TOKENS:
        if p == token or p.startswith(token + "/"):
            p = ctx.home + p[len(token):]
    if "$" in p:
        return None
    if p == "~" or p.startswith("~/"):
        p = ctx.home + p[1:]
    elif p.startswith("~"):
        return None  # ~otheruser
    if not _isabs(p):
        if not ctx.cwd:
            return None  # after a `cd` to a computed directory
        p = posixpath.join(ctx.cwd, p)
    return _norm(p)


def _glob_base(path: str) -> str:
    """The directory a glob can reach: '/a/b/*.x' -> '/a/b'."""
    parts = path.split("/")
    for i, part in enumerate(parts):
        if _GLOB_CHARS & set(part):
            base = "/".join(parts[:i])
            if _WINDOWS and _DRIVE_RE.fullmatch(base):
                base += "/"
            return base or "/"
    return path


def _inside(root: str, path: str) -> bool:
    if not root:
        return False
    return path == root or path.startswith(root.rstrip("/") + "/")


def _is_temp(path: str) -> bool:
    tmpdirs = [os.environ.get(v, "") for v in (("TMPDIR", "TEMP", "TMP") if _WINDOWS else ("TMPDIR",))]
    roots = _TEMP_ROOTS + tuple(_norm(t) for t in tmpdirs if t)
    return any(path != r and _inside(r, path) for r in roots)


def _credential_kind(path: str, ctx: _Ctx) -> str | None:
    """'credential' for secret stores, None otherwise."""
    h = ctx.home
    rel = path[len(h) + 1:] if _inside(h, path) and path != h else None
    if rel is not None:
        first = rel.split("/", 1)[0]
        if first in {".ssh", ".aws", ".gnupg", ".netrc", ".kube", ".docker", ".azure", ".gcloud"}:
            if first == ".kube" and not rel.startswith(".kube/config"):
                return None
            if first == ".docker" and rel != ".docker/config.json":
                return None
            return "credential"
        if rel.startswith("Library/Keychains"):
            return "credential"
        if rel.startswith(".config/gcloud") or rel == ".config/gh/hosts.yml":
            return "credential"
        base = posixpath.basename(path)
        if rel.startswith(".claude/") and base.startswith(".credentials"):
            return "credential"
        if rel.startswith(".codex/") and base.startswith("auth"):
            return "credential"
    if path.startswith("/Library/Keychains") or path.endswith(".keychain") or path.endswith(".keychain-db"):
        return "credential"
    return None


def _is_dotenv(path: str) -> bool:
    base = posixpath.basename(path)
    return base == ".env" or (base.startswith(".env.") and base not in {".env.example", ".env.sample", ".env.template"})


def _agent_config(path: str, ctx: _Ctx) -> bool:
    h = ctx.home
    return (
        _inside(posixpath.join(h, ".claude"), path)
        and fnmatch.fnmatch(posixpath.basename(path), "settings*.json")
        and posixpath.dirname(path) == posixpath.join(h, ".claude")
    ) or path == posixpath.join(h, ".codex", "config.toml")


def _check_path(acc: _Acc, path: str, ctx: _Ctx, *, write: bool, list_only: bool = False) -> None:
    ws = ctx.workspace
    if _credential_kind(path, ctx):
        if list_only:
            acc.hit("high", "credential-path-list", f"lists a credential location: {path}")
        else:
            acc.hit("critical", "credential-access", f"touches a credential store: {path}")
        return
    if _is_dotenv(path) and not _inside(ws, path):
        acc.hit("critical", "dotenv-outside-workspace", f".env file outside the workspace: {path}")
        return
    if not write:
        return
    if "/.git/hooks/" in path + "/" and path.rstrip("/").split("/.git/hooks", 1)[1:] != [""]:
        acc.hit("high", "git-hooks-write", f"writes a git hook: {path}")
    elif "/.github/workflows/" in path:
        acc.hit("high", "ci-workflow-write", f"writes a CI workflow: {path}")
    elif _agent_config(path, ctx):
        acc.hit("high", "agent-config-write", f"writes agent CLI settings (hooks live there): {path}")


# ---------------------------------------------------------------- shell parsing


def _extract_substitutions(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Replace $(...), `...`, <(...), >(...) with placeholders and turn
    unquoted newlines into ';'. Returns (flat text, [(kind, inner)])."""
    out: list[str] = []
    subs: list[tuple[str, str]] = []
    i, n = 0, len(text)
    in_single = in_double = False
    while i < n:
        c = text[i]
        if c == "\\" and not in_single and i + 1 < n:
            if text[i + 1] == "\n":
                i += 2
                continue
            out.append(text[i:i + 2])
            i += 2
            continue
        if c == "'" and not in_double:
            in_single = not in_single
        elif c == '"' and not in_single:
            in_double = not in_double
        elif not in_single and (text.startswith("$(", i) or (not in_double and text[i:i + 2] in ("<(", ">("))):
            kind = "process" if c in "<>" else "command"
            depth, j = 1, i + 2
            while j < n and depth:
                if text[j] == "(":
                    depth += 1
                elif text[j] == ")":
                    depth -= 1
                j += 1
            subs.append((kind, text[i + 2:j - 1] if depth == 0 else text[i + 2:]))
            out.append(f"{_PLACEHOLDER}{len(subs) - 1}\x00")
            i = j
            continue
        elif c == "`" and not in_single:
            j = text.find("`", i + 1)
            j = n if j < 0 else j
            subs.append(("command", text[i + 1:j]))
            out.append(f"{_PLACEHOLDER}{len(subs) - 1}\x00")
            i = j + 1
            continue
        elif c == "\n" and not in_single and not in_double:
            out.append(";")
            i += 1
            continue
        out.append(c)
        i += 1
    return "".join(out), subs


@dataclass
class _Cmd:
    argv: list[str]
    redirects: list[tuple[str, str]]  # (op, target)


_SEPARATORS = {";", "&&", "||", "&", ";;", "(", ")", "\n"}
_PIPES = {"|", "|&"}


def _split(text: str) -> list[list[_Cmd]]:
    """Lists of pipelines; raises ValueError on unbalanced quotes."""
    lex = shlex.shlex(text, posix=True, punctuation_chars=True)
    lex.whitespace_split = True
    lex.commenters = "#"
    pipelines: list[list[_Cmd]] = []
    pipeline: list[_Cmd] = []
    cur = _Cmd([], [])
    pending_redirect: str | None = None

    def close_cmd() -> None:
        nonlocal cur
        if cur.argv or cur.redirects:
            pipeline.append(cur)
        cur = _Cmd([], [])

    for tok in lex:
        if pending_redirect is not None:
            cur.redirects.append((pending_redirect, tok))
            pending_redirect = None
            continue
        if tok in _PIPES:
            close_cmd()
            continue
        if tok in _SEPARATORS or (tok and set(tok) <= set(";&|()") ):
            close_cmd()
            if pipeline:
                pipelines.append(pipeline)
            pipeline = []
            continue
        if tok and set(tok) <= set("<>&") and ("<" in tok or ">" in tok):
            if tok.endswith("&"):
                continue  # >&2 style fd dup; the next token is an fd
            pending_redirect = tok
            continue
        cur.argv.append(tok)
    close_cmd()
    if pipeline:
        pipelines.append(pipeline)
    return pipelines


def _unwrap(argv: list[str], acc: _Acc) -> tuple[list[str], bool]:
    """Strip sudo/env/nohup/time/... wrappers. Returns (argv, from_stdin)."""
    from_stdin = False
    while argv:
        word = os.path.basename(argv[0]) if "/" in argv[0] else argv[0]
        if word in LEADING_KEYWORDS:
            argv = argv[1:]
        elif re.match(r"^[A-Za-z_][A-Za-z0-9_]*=", argv[0]):
            argv = argv[1:]
        elif word in {"sudo", "doas"}:
            acc.hit("critical", "sudo", "runs with elevated privileges (sudo)")
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-u", "-g", "-C", "-h", "-p", "-U", "-r", "-t"} and argv:
                    argv = argv[1:]
        elif word == "su":
            acc.hit("critical", "sudo", "switches user (su)")
            return [], from_stdin
        elif word == "env":
            argv = argv[1:]
            while argv and (argv[0].startswith("-") or "=" in argv[0]):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-u", "-C", "-S"} and argv:
                    argv = argv[1:]
        elif word in WRAPPERS_NO_ARG:
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                argv = argv[1:]
        elif word in {"nice", "timeout", "ionice"}:
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-n", "-s", "-k", "-c"} and argv:
                    argv = argv[1:]
            if word == "timeout" and argv:
                argv = argv[1:]  # duration
        elif word == "xargs":
            from_stdin = True
            argv = argv[1:]
            while argv and argv[0].startswith("-"):
                opt = argv[0]
                argv = argv[1:]
                if opt in {"-I", "-n", "-P", "-L", "-d", "-E", "-s"} and argv:
                    argv = argv[1:]
        else:
            break
    return argv, from_stdin


def _classify_script(text: str, ctx: _Ctx, acc: _Acc, depth: int = 0) -> None:
    if depth > 6:
        acc.opaque("nesting-too-deep", "command nests too deeply to analyse")
        return
    flat, subs = _extract_substitutions(text)
    try:
        pipelines = _split(flat)
    except ValueError:
        acc.opaque("unbalanced-quotes", "command has unbalanced quotes")
        return
    sub_downloads = {i for i, (_, inner) in enumerate(subs) if _mentions_downloader(inner)}
    for _, inner in subs:
        _classify_script(inner, ctx, acc, depth + 1)
    for pipeline in pipelines:
        _classify_pipeline(pipeline, ctx, acc, sub_downloads, depth)


def _mentions_downloader(text: str) -> bool:
    return any(re.search(rf"(^|[\s;|&(/]){d}(\s|$)", text) for d in DOWNLOADERS)


def _sub_index(arg: str) -> int | None:
    m = re.search(re.escape(_PLACEHOLDER) + r"(\d+)\x00", arg)
    return int(m.group(1)) if m else None


def _classify_pipeline(pipeline: list[_Cmd], ctx: _Ctx, acc: _Acc, sub_downloads: set[int], depth: int) -> None:
    upstream: set[str] = set()  # kinds of producers earlier in this pipeline
    for idx, cmd in enumerate(pipeline):
        argv, from_stdin = _unwrap(list(cmd.argv), acc)
        from_stdin = from_stdin or idx > 0
        for op, target in cmd.redirects:
            path = _resolve(target, ctx)
            if path:
                _check_path(acc, path, ctx, write=">" in op)
        if not argv:
            continue
        word_raw = argv[0]
        word = os.path.basename(word_raw)
        if word_raw in SKIP_SEGMENT_KEYWORDS:
            continue
        if _PLACEHOLDER in word_raw or "$" in word_raw:
            acc.opaque("dynamic-command", "command name is computed at run time")
            continue
        if word == "eval":
            acc.opaque("eval", "eval runs a string that cannot be analysed statically")
            if any((i := _sub_index(a)) is not None and i in sub_downloads for a in argv[1:]):
                acc.hit("critical", "pipe-download-to-shell", "executes content fetched from the network")
            _classify_script(" ".join(argv[1:]), ctx, acc, depth + 1)
            continue
        if word in {"source", "."} and len(argv) > 1:
            _check_script_exec(argv[1], ctx, acc, sub_downloads)
            continue

        if word in INTERPRETERS:
            _classify_interpreter(word, argv, ctx, acc, upstream, sub_downloads, depth)
        else:
            if "/" in word_raw:
                _check_script_exec(word_raw, ctx, acc, sub_downloads)
            _classify_command(word, argv, ctx, acc, from_stdin)

        if word in DOWNLOADERS:
            upstream.add("download")
            _track_downloads(word, argv, ctx)
        elif word in DECODERS and any(a in {"-d", "-D", "--decode", "-r"} or a.startswith("-d") for a in argv[1:]):
            upstream.add("decode")
        else:
            upstream.add("other")


def _classify_interpreter(word, argv, ctx, acc, upstream, sub_downloads, depth) -> None:
    args = argv[1:]
    code_flag = {"-c"} if word in SHELLS else {"-c", "-e", "-E", "--eval", "-r"}
    script: str | None = None
    code: str | None = None
    i = 0
    while i < len(args):
        a = args[i]
        if a in code_flag or (word in SHELLS and a.startswith("-") and not a.startswith("--") and "c" in a[1:]):
            code = args[i + 1] if i + 1 < len(args) else ""
            break
        if a == "-" or a == "-s":
            break
        if a.startswith("-"):
            if word not in SHELLS and a in {"-m"}:
                return  # python -m module: a named module, not a script
            i += 1
            continue
        script = a
        break
    if code is not None:
        if word in SHELLS:
            idx = _sub_index(code)
            if idx is not None and idx in sub_downloads:
                acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
            _classify_script(code, ctx, acc, depth + 1)
        else:
            acc.opaque("interpreter-inline-code", f"{word} runs inline code that is not analysed")
        return
    if script is not None:
        idx = _sub_index(script)
        if idx is not None and idx in sub_downloads:
            acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
            return
        _check_script_exec(script, ctx, acc, sub_downloads)
        return
    # No script and no -c: the interpreter reads its program from stdin.
    if "download" in upstream:
        acc.hit("critical", "pipe-download-to-shell", "pipes a network download into an interpreter")
    elif "decode" in upstream:
        acc.hit("high", "decode-and-exec", "pipes decoded data into an interpreter")
        acc.opaque("decode-and-exec", "pipes decoded data into an interpreter")
    elif upstream:
        acc.opaque("stdin-script", "interpreter runs a program read from a pipe")


def _track_downloads(word: str, argv: list[str], ctx: _Ctx) -> None:
    args = argv[1:]
    for i, a in enumerate(args):
        target = None
        if a in {"-o", "--output", "-O", "--output-document"} and i + 1 < len(args):
            target = args[i + 1]
            if word == "curl" and a == "-O":
                target = None
        elif a.startswith("--output=") or a.startswith("--output-document="):
            target = a.split("=", 1)[1]
        if target:
            path = _resolve(target, ctx)
            if path:
                ctx.downloaded.add(path)


def _check_script_exec(script: str, ctx: _Ctx, acc: _Acc, sub_downloads: set[int]) -> None:
    idx = _sub_index(script)
    if idx is not None:
        if idx in sub_downloads:
            acc.hit("critical", "pipe-download-to-shell", "executes a script fetched from the network")
        else:
            acc.opaque("unknown-script", "executes a script whose path is computed at run time")
        return
    path = _resolve(script, ctx)
    if path is None:
        acc.opaque("unknown-script", f"executes a script whose path is not static: {script}")
        return
    if path in ctx.downloaded:
        acc.hit("critical", "download-then-exec", f"executes a file downloaded in the same command: {script}")
        acc.opaque("download-then-exec", "executes a downloaded script")
        return
    if _inside(ctx.workspace, path) or path.startswith(SYSTEM_BIN_PREFIXES):
        return
    if _inside(posixpath.join(ctx.home, ".local", "bin"), path):
        return
    acc.opaque("unknown-script", f"executes a script outside the workspace: {path}")


# ---------------------------------------------------------------- command rules


def _flags(args: list[str]) -> set[str]:
    out: set[str] = set()
    for a in args:
        if a == "--":
            break
        if a.startswith("--"):
            out.add(a.split("=", 1)[0])
        elif a.startswith("-") and len(a) > 1:
            out.update(f"-{ch}" for ch in a[1:])
    return out


def _positionals(args: list[str]) -> list[str]:
    out, after_dd = [], False
    for a in args:
        if after_dd:
            out.append(a)
        elif a == "--":
            after_dd = True
        elif not a.startswith("-") or a == "-":
            out.append(a)
    return out


def _classify_command(word: str, argv: list[str], ctx: _Ctx, acc: _Acc, from_stdin: bool) -> None:
    args = argv[1:]
    if word in NON_PATH_CMDS:
        return
    if word in {"cd", "pushd"}:
        pos = _positionals(args)
        target = pos[0] if pos else "~"
        ctx.cwd = _resolve(target, ctx) or ""
        return
    if word == "rm":
        _classify_rm(args, ctx, acc, from_stdin, recursive=bool(_flags(args) & {"-r", "-R", "--recursive"}))
        return
    if word == "find" and ("-delete" in args or ("-exec" in args and "rm" in args) or ("-execdir" in args and "rm" in args)):
        roots = []
        for a in args:
            if a.startswith("-") or a in {"(", "!", ")"}:
                break
            roots.append(a)
        _classify_rm(roots or ["."], ctx, acc, from_stdin=False, recursive=True, filtered=True)
        return
    if word == "dd":
        if any(a.startswith("of=/dev/") for a in args):
            acc.hit("critical", "disk-write", "dd writes directly to a device")
        else:
            acc.hit("high", "dd", "dd copies raw data")
        return
    if word.startswith("mkfs") or word.startswith("newfs") or word in {"fdisk", "sfdisk", "gpt", "wipefs"}:
        acc.hit("critical", "disk-format", f"{word} formats or repartitions a disk")
        return
    if word == "diskutil" and args:
        sub = args[0].lower()
        if sub.startswith(("erase", "zero", "random", "secureerase", "partition", "reformat")) or (
            sub in {"apfs", "cs", "ar"} and len(args) > 1 and args[1].lower().startswith(("delete", "erase"))
        ):
            acc.hit("critical", "disk-format", f"diskutil {args[0]} erases or repartitions a disk")
        return
    if word == "security" and args:
        sub = args[0]
        if re.match(r"^(find-(generic|internet)-password|dump-keychain|export|delete-|unlock-keychain|set-generic-password|add-generic-password)", sub):
            acc.hit("critical", "keychain-access", f"reads or changes the Keychain (security {sub})")
        return
    if word == "git":
        _classify_git(args, ctx, acc)
        return
    if len(args) >= 1 and (word, args[0]) in PUBLISH or (word == "yarn" and args[:2] == ["npm", "publish"]):
        acc.hit("high", "package-publish", f"publishes a package ({word} {args[0]})")
        return
    if word in {"terraform", "tofu"} and args and (args[0] == "destroy" or (args[0] == "apply" and "-destroy" in args)):
        acc.hit("critical", "cloud-destroy", f"{word} destroys infrastructure")
        return
    if word == "kubectl" and "delete" in _positionals(args):
        acc.hit("critical", "cloud-destroy", "kubectl deletes cluster resources")
        return
    if word == "aws":
        pos = _positionals(args)
        if any(p.startswith(("delete-", "terminate-")) for p in pos) or (
            pos[:2] == ["s3", "rb"] or (pos[:2] == ["s3", "rm"] and "--recursive" in args)
        ):
            acc.hit("critical", "cloud-destroy", "aws command deletes cloud resources")
        return
    if word in {"gcloud", "az"} and "delete" in _positionals(args):
        acc.hit("critical", "cloud-destroy", f"{word} deletes cloud resources")
        return
    if word in DOWNLOADERS:
        _classify_upload(word, args, ctx, acc)
        return
    # Generic: any path-like argument that names a credential store or a
    # protected write target.
    list_only = word in LIST_ONLY
    writes = word in {"cp", "mv", "tee", "install", "ln", "rsync", "scp", "touch", "chmod", "sed", "truncate"}
    for a in args:
        for cand in _arg_paths(a):
            path = _resolve(cand, ctx)
            if path:
                _check_path(acc, path, ctx, write=writes, list_only=list_only)


def _arg_paths(arg: str) -> list[str]:
    """Candidate paths inside one argument: 'x', '@x', '--opt=x', 'k=@x'."""
    if not arg or arg == "-":
        return []
    cands = []
    if arg.startswith("-"):
        if "=" in arg:
            arg = arg.split("=", 1)[1]
        else:
            return []
    elif "=" in arg and not arg.startswith(("/", "~", ".")):
        arg = arg.split("=", 1)[1]
    if arg.startswith("@"):
        arg = arg[1:]
    if arg.startswith(("/", "~", ".") + _HOME_TOKENS) or "/" in arg or arg.startswith(".env"):
        cands.append(arg)
    elif _WINDOWS and ("\\" in arg or _DRIVE_RE.match(arg)):
        cands.append(arg)
    return cands


def _classify_rm(
    targets: list[str], ctx: _Ctx, acc: _Acc, from_stdin: bool, recursive: bool, filtered: bool = False
) -> None:
    paths = _positionals(targets)
    if from_stdin and not paths and recursive:
        acc.hit("high", "rm-unresolved-target", "recursive rm on targets read from stdin")
        acc.opaque("rm-unresolved-target", "rm targets come from stdin")
        return
    ws = ctx.workspace
    for raw in paths:
        path = _resolve(raw, ctx)
        if path is None:
            acc.hit("high", "rm-unresolved-target", f"rm target is computed at run time: {raw}")
            acc.opaque("rm-unresolved-target", f"rm target is computed at run time: {raw}")
            continue
        base = _glob_base(path)
        if _credential_kind(base, ctx) or _credential_kind(path, ctx):
            acc.hit("critical", "credential-access", f"deletes a credential store: {path}")
            continue
        if base in {"/", ctx.home} or (_WINDOWS and _DRIVE_RE.fullmatch(base.rstrip("/"))) or (ws and _inside(base, ws) and base != ws):
            acc.hit("critical", "rm-root-or-home", f"deletes the root, home, or a parent of the workspace: {path}")
            continue
        if ws and _inside(ws, path):
            if not recursive:
                continue
            if path == ws and not filtered:
                acc.hit("critical", "rm-workspace-root", "recursively deletes the whole workspace")
            else:
                acc.hit("high", "rm-recursive-in-workspace", f"recursive delete inside the workspace: {path}")
            continue
        if _is_temp(base):
            continue
        if recursive:
            acc.hit("critical", "rm-outside-workspace", f"recursive delete outside the workspace: {path}")
        else:
            acc.hit("high", "rm-file-outside-workspace", f"deletes a file outside the workspace: {path}")


def _classify_git(args: list[str], ctx: _Ctx, acc: _Acc) -> None:
    i = 0
    while i < len(args) and args[i].startswith("-"):
        if args[i] in {"-C", "-c", "--git-dir", "--work-tree", "--namespace"} and i + 1 < len(args):
            i += 2
        else:
            i += 1
    if i >= len(args):
        return
    sub, rest = args[i], args[i + 1:]
    fl = _flags(rest)
    if sub == "push":
        pos = _positionals(rest)
        refspecs = pos[1:]
        force = bool(fl & {"-f", "--force", "--force-with-lease", "--force-if-includes", "--mirror"}) or any(
            r.startswith("+") for r in refspecs
        )
        delete = bool(fl & {"-d", "--delete"})
        dsts = set()
        for r in refspecs:
            r = r.lstrip("+")
            dst = r.split(":", 1)[1] if ":" in r else r
            if r.startswith(":"):
                delete = True
            dsts.add(dst.removeprefix("refs/heads/"))
        protected = dsts & PROTECTED_BRANCHES
        if (force or delete) and protected:
            acc.hit("critical", "git-force-push-protected",
                    f"force-pushes or deletes protected branch {', '.join(sorted(protected))}")
        elif force:
            acc.hit("high", "git-push-force", "force push (history rewrite on the remote)")
        else:
            acc.hit("high", "git-push", "pushes to a remote")
    elif sub == "reset" and "--hard" in fl:
        acc.hit("high", "git-reset-hard", "git reset --hard discards local changes")
    elif sub == "clean" and fl & {"-f", "--force"}:
        acc.hit("high", "git-clean-force", "git clean -f deletes untracked files")


def _classify_upload(word: str, args: list[str], ctx: _Ctx, acc: _Acc) -> None:
    files: list[str] = []
    for i, a in enumerate(args):
        nxt = args[i + 1] if i + 1 < len(args) else ""
        if a in {"-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form"}:
            if "@" in nxt:
                files.append(nxt.split("@", 1)[1].split(";", 1)[0])
        elif a.startswith(("--data=", "--data-binary=", "--form=")) and "@" in a:
            files.append(a.split("@", 1)[1])
        elif a in {"-T", "--upload-file", "--post-file", "--body-file"}:
            files.append(nxt)
        elif a.startswith(("--post-file=", "--body-file=")):
            files.append(a.split("=", 1)[1])
    hosts = [a for a in args if re.match(r"^https?://", a)]
    local = hosts and all(re.match(r"^https?://(localhost|127\.0\.0\.1|\[::1\])([:/]|$)", h) for h in hosts)
    for f in files:
        path = _resolve(f, ctx)
        if path and (_credential_kind(path, ctx) or _is_dotenv(path)):
            acc.hit("critical", "credential-exfil", f"uploads a secret file: {path}")
        elif not local:
            acc.hit("high", "http-upload-file", f"uploads a local file with {word}")


# ---------------------------------------------------------------- entry points


def _ctx(cwd: str, workspace: str) -> _Ctx:
    home = _home()
    ws = _norm(os.path.expanduser(workspace)) if workspace else ""
    base = _norm(os.path.expanduser(cwd)) if cwd else (ws or home)
    return _Ctx(cwd=base, workspace=ws, home=home)


def _tool_command(tool_input: dict) -> str | None:
    cmd = tool_input.get("command", tool_input.get("cmd"))
    if isinstance(cmd, list):
        cmd = [str(c) for c in cmd]
        # codex style ["bash", "-lc", "<script>"] keeps working as a plain argv.
        return shlex.join(cmd)
    if isinstance(cmd, str):
        return cmd
    return None


def _tool_paths(tool_input: dict) -> list[str]:
    out = []
    for key in ("file_path", "path", "notebook_path", "filename", "target_file", "absolute_path"):
        v = tool_input.get(key)
        if isinstance(v, str) and v:
            out.append(v)
    return out


def classify(tool: str, tool_input: dict, *, cwd: str, workspace: str) -> Verdict:
    acc = _Acc()
    ctx = _ctx(cwd, workspace)
    name = (tool or "").strip().lower()
    tool_input = tool_input if isinstance(tool_input, dict) else {}
    if name == "prompt":
        # The rendered text of a permission prompt (chat relay).
        return classify_prompt_text(str(tool_input.get("text") or ""), workspace=workspace)
    if name in SHELL_TOOLS:
        command = _tool_command(tool_input)
        if command and name == "powershell":
            # A backslash separates paths in PowerShell rather than escaping; '/' is equivalent there.
            command = command.replace("\\", "/")
        if command:
            _classify_script(command, ctx, acc)
    elif name in WRITE_TOOLS or name in READ_TOOLS:
        for raw in _tool_paths(tool_input):
            path = _resolve(raw, ctx)
            if path is None:
                acc.opaque("dynamic-path", f"path is not static: {raw}")
                continue
            _check_path(acc, path, ctx, write=name in WRITE_TOOLS)
    return acc.verdict()


_TOOL_CALL_RE = re.compile(r"\b[A-Z][A-Za-z]*\((.+)\)\s*$")
_BOX_CHARS = "│┃║|╭╮╰╯─━═>❯›•●○◯▸▶*⎿ \t"


def classify_prompt_text(text: str, *, workspace: str) -> Verdict:
    """Screen the rendered text of a CLI permission prompt (relay path).

    The prompt layout differs per vendor, so every line is classified as if
    it were a command, tool-call wrappers like ``Bash(rm -rf x)`` are
    unwrapped, and the most severe level wins. Lines that are prose simply
    come out "normal". Parseability only reflects lines that parsed as shell.
    """
    acc = _Acc()
    ctx = _ctx(workspace, workspace)
    for raw_line in (text or "").splitlines():
        line = raw_line.strip().strip(_BOX_CHARS).strip()
        if not line:
            continue
        if line.startswith("$ "):
            line = line[2:]
        # A bare path line ("Read file\n  ~/.ssh/id_rsa") is not a command
        # argument, so screen every path-looking word directly as well.
        for word in re.split(r"[\s()'\"`,]+", line):
            for cand in _arg_paths(word):
                path = _resolve(cand, ctx)
                if path:
                    _check_path(acc, path, ctx, write=False)
        m = _TOOL_CALL_RE.search(line)
        candidates = [line] + ([m.group(1)] if m else [])
        for cand in candidates:
            sub = _Acc()
            _classify_script(cand, _Ctx(ctx.cwd, ctx.workspace, ctx.home), sub)
            if "unbalanced-quotes" in sub.rules:
                # Prose with apostrophes ("don't ask again"): retry without quotes.
                sub = _Acc()
                _classify_script(re.sub(r"[\"'`]", " ", cand), _Ctx(ctx.cwd, ctx.workspace, ctx.home), sub)
            for rule, reason in zip(sub.rules, sub.reasons):
                if rule != "unbalanced-quotes" and rule not in acc.rules:
                    acc.rules.append(rule)
                    acc.reasons.append(reason)
            if LEVEL_ORDER[sub.level] > LEVEL_ORDER[acc.level]:
                acc.level = sub.level
            if not sub.parseable and set(sub.rules) - {"unbalanced-quotes"}:
                acc.parseable = False
    return acc.verdict()
