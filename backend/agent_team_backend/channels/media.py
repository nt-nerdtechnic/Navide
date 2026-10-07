"""Chat attachments: where inbound files are kept and which files a pane may send.

Inbound files from an allowed sender go to ``<app data>/channels-media/<pane>/`` under
a random prefix and a name of safe characters only, and are pruned after
``RETENTION_S``. Outbound, a pane names a file on a ``---ATTACH--- <absolute path>``
line inside an MSG block addressed to the chat; ``resolve_outbound`` admits only a
regular file inside the pane's workspace or the media directory, judged after
symlinks are resolved, and never a dotfile, a credential-shaped name or a system file.
"""

from __future__ import annotations

import fnmatch
import mimetypes
import os
import re
import secrets
import time
from pathlib import Path

MEDIA_DIRNAME = "channels-media"
# Telegram's getFile serves at most 20 MB, and the same cap keeps every platform alike.
INBOUND_MAX_BYTES = 20 * 1024 * 1024
RETENTION_S = 7 * 86400.0
PRUNE_EVERY_S = 3600.0
MAX_ATTACHMENTS_PER_REPLY = 10
NAME_MAX_CHARS = 100

ATTACH_MARKER = "---ATTACH---"
_ATTACH_RE = re.compile(r"^---ATTACH---[ \t]+(\S.*?)[ \t]*$")
_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9._-]+")

# Names a pane may never send, whatever folder they sit in (fnmatch, case-insensitive).
DENIED_NAMES = (
    "*.pem", "*.key", "*.p12", "*.pfx", "*.jks", "*.keystore", "*.kdbx", "*.ovpn",
    "*.keychain", "*.keychain-db", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
    "credentials", "credentials.*", "*.tfstate", "*.tfstate.*",
)
# System folders refused even inside a workspace that happens to contain them.
SYSTEM_ROOTS = (
    "/etc", "/private/etc", "/System", "/bin", "/sbin", "/usr/bin", "/usr/sbin",
    "/Library/Keychains", "/private/var/db", "C:\\Windows",
)

_KIND_DEFAULT_NAMES = {
    "photo": "photo.jpg", "voice": "voice.ogg", "video_note": "video_note.mp4",
    "video": "video.mp4", "animation": "animation.mp4", "audio": "audio",
}


def media_root(data_dir: Path) -> Path:
    return data_dir / MEDIA_DIRNAME


def safe_name(name: str, kind: str = "file", mime: str = "") -> str:
    """``name`` reduced to ``[A-Za-z0-9._-]`` (no leading dot), or a name made from
    ``kind`` and ``mime`` when nothing is left."""
    stem, ext = os.path.splitext(os.path.basename((name or "").replace("\\", "/")))
    stem = _UNSAFE_RE.sub("_", stem).strip("._")[:NAME_MAX_CHARS]
    ext = _UNSAFE_RE.sub("", ext)[:10]
    if stem and ext != ".":
        return stem + ext
    fallback = _KIND_DEFAULT_NAMES.get(kind, "file")
    if ext and ext != ".":
        return os.path.splitext(fallback)[0] + ext  # e.g. "報告.pdf" -> "file.pdf"
    if "." not in fallback:
        fallback += mimetypes.guess_extension(mime or "") or ".bin"
    return fallback


def pane_dir(root: Path, pane_id: str) -> Path:
    """One pane's folder under the media root. A pane may send only its own folder's
    files: another pane's came from another chat."""
    return root / (_UNSAFE_RE.sub("_", pane_id).strip("._") or "pane")


def new_inbound_path(root: Path, pane_id: str, name: str) -> Path:
    """A fresh path for one inbound file: ``root/<pane>/<random>-<name>``."""
    folder = pane_dir(root, pane_id)
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return folder / f"{secrets.token_hex(4)}-{name}"


def prune(root: Path, now: float | None = None, retention_s: float = RETENTION_S) -> int:
    """Delete files older than ``retention_s`` (and any symlink) under ``root``, then
    empty pane folders; returns how many files went. Never follows a symlink."""
    if not root.is_dir():
        return 0
    cutoff = (time.time() if now is None else now) - retention_s
    removed = 0
    for folder, dirs, files in os.walk(root, topdown=False, followlinks=False):
        for entry in files + [d for d in dirs if os.path.islink(os.path.join(folder, d))]:
            path = os.path.join(folder, entry)
            try:
                st = os.lstat(path)
                if os.path.islink(path) or st.st_mtime < cutoff:
                    os.unlink(path)
                    removed += 1
            except OSError:
                continue
        if folder != str(root):
            try:
                os.rmdir(folder)  # only succeeds when empty
            except OSError:
                pass
    return removed


def human_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024 or unit == "GB":
            return f"{int(size)} {unit}" if unit == "B" else f"{size:.1f}".removesuffix(".0") + f" {unit}"
        size /= 1024
    return f"{n} B"


def split_attachments(body: str) -> tuple[str, list[str]]:
    """(``body`` without its ``---ATTACH---`` lines, the paths they name). Lines inside a
    code fence are text, not attachments."""
    kept: list[str] = []
    paths: list[str] = []
    in_fence = False
    for line in body.split("\n"):
        if _FENCE_RE.match(line):
            in_fence = not in_fence
        elif not in_fence:
            m = _ATTACH_RE.match(line)
            if m:
                paths.append(m.group(1))
                continue
        kept.append(line)
    return "\n".join(kept).strip("\n"), paths


def resolve_outbound(raw: str, roots: list[str | Path]) -> tuple[Path | None, str]:
    """(the real file, "") when a pane may send ``raw``, else (None, reason): one of
    not_absolute, parent_ref, missing, not_file, outside, hidden, denied_name, system."""
    path = Path(raw.strip())
    if not path.is_absolute():
        return None, "not_absolute"
    if ".." in path.parts:
        return None, "parent_ref"
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, "missing"
    if not real.is_file():
        return None, "not_file"
    for root in roots:
        if not root:
            continue
        try:
            base = Path(root).resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if base == Path(base.anchor) or not real.is_relative_to(base):
            continue  # a filesystem root is never a usable workspace
        rel = real.relative_to(base).parts
        if any(part.startswith(".") for part in rel):
            return None, "hidden"
        if any(fnmatch.fnmatch(real.name.lower(), pat) for pat in DENIED_NAMES):
            return None, "denied_name"
        if any(real == Path(s) or real.is_relative_to(Path(s)) for s in SYSTEM_ROOTS):
            return None, "system"
        return real, ""
    return None, "outside"


# Chat-side notices, in the languages quick_menu.STRINGS covers.
STRINGS: dict[str, dict[str, str]] = {
    "zh-TW": {
        "unsupported": "此平台尚不支援媒體",
        "too_large": "⚠️ 檔案「{name}」超過 {limit} 上限，沒有收下",
        "download_failed": "⚠️ 檔案「{name}」下載失敗：{error}",
        "refused": "⚠️ 不傳送「{name}」：{reason}",
        "too_large_out": "⚠️ 不傳送「{name}」：{size} 超過這個平台 {limit} 的上限",
        "send_failed": "⚠️ 檔案「{name}」傳送失敗：{error}",
        "too_many": "⚠️ 一次最多傳 {max} 個檔案，其餘的沒有傳",
        "reason.not_absolute": "必須是絕對路徑",
        "reason.parent_ref": "路徑不可含 ..",
        "reason.missing": "找不到這個檔案",
        "reason.not_file": "不是一般檔案",
        "reason.outside": "只能傳 workspace 或附件資料夾裡的檔案",
        "reason.hidden": "不傳隱藏檔或隱藏資料夾裡的檔案",
        "reason.denied_name": "這個檔名看起來是憑證或金鑰",
        "reason.system": "不傳系統檔案",
    },
    "en-US": {
        "unsupported": "This platform does not support media yet",
        "too_large": "⚠️ \"{name}\" is over the {limit} limit, so it was not received",
        "download_failed": "⚠️ \"{name}\" could not be downloaded: {error}",
        "refused": "⚠️ Not sending \"{name}\": {reason}",
        "too_large_out": "⚠️ Not sending \"{name}\": {size} is over this platform's {limit} limit",
        "send_failed": "⚠️ \"{name}\" could not be sent: {error}",
        "too_many": "⚠️ At most {max} files go out at once; the rest were not sent",
        "reason.not_absolute": "it must be an absolute path",
        "reason.parent_ref": "the path may not contain ..",
        "reason.missing": "the file does not exist",
        "reason.not_file": "it is not a regular file",
        "reason.outside": "only files in the workspace or the attachments folder can be sent",
        "reason.hidden": "hidden files and files in hidden folders are not sent",
        "reason.denied_name": "the name looks like a credential or key",
        "reason.system": "system files are not sent",
    },
    "ja-JP": {
        "unsupported": "このプラットフォームはまだメディアに対応していません",
        "too_large": "⚠️ ファイル「{name}」は上限 {limit} を超えているため、受け取りませんでした",
        "download_failed": "⚠️ ファイル「{name}」をダウンロードできませんでした：{error}",
        "refused": "⚠️「{name}」は送信しません：{reason}",
        "too_large_out": "⚠️「{name}」は送信しません：{size} はこのプラットフォームの上限 {limit} を超えています",
        "send_failed": "⚠️ ファイル「{name}」を送信できませんでした：{error}",
        "too_many": "⚠️ 一度に送れるファイルは {max} 個までです。残りは送信していません",
        "reason.not_absolute": "絶対パスで指定してください",
        "reason.parent_ref": "パスに .. は使えません",
        "reason.missing": "ファイルが見つかりません",
        "reason.not_file": "通常のファイルではありません",
        "reason.outside": "送れるのは workspace か添付ファイルフォルダ内のファイルだけです",
        "reason.hidden": "隠しファイルや隠しフォルダ内のファイルは送信しません",
        "reason.denied_name": "認証情報や鍵のようなファイル名です",
        "reason.system": "システムファイルは送信しません",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: object) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def attachment_line(kind: str, name: str, size: int, path: Path) -> str:
    """What the pane is told about one received file."""
    return f"[附件] {kind} {name} {human_size(size)} → {path}"
