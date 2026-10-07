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
import stat
import time
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import BinaryIO

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

# Names a pane may never send: matched (fnmatch, case-insensitive) against every segment
# of the path below the allowed folder, so a credentials/ or secrets/ folder counts too.
# Errs on the side of refusing: a refused file can still be shared by hand.
DENIED_NAMES = (
    # keys, certificates and keystores
    "*.pem", "*.key", "*.p12", "*.pfx", "*.p8", "*.pkcs12", "*.jks", "*.keystore", "*.ppk",
    "*.der", "*.gpg", "*.pgp", "*.asc", "*.kdbx", "*.ovpn", "*.keychain", "*.keychain-db",
    "keychains", "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
    # credentials, tokens and environment files (prod.env, env.local ...)
    "credentials*", "*secret*", "*token*", "*password*", "*passwd*", "*.env", "env.*",
    "*.tfstate", "*.tfstate.*", "*.netrc", "*.npmrc", "*.pypirc",
    # browser and app databases (cookies, saved logins)
    "cookies", "cookies-journal", "login data", "login data-journal", "web data",
    "*.sqlite", "*.sqlite3", "*.db", "*.db-wal", "*.db-shm",
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


def _home() -> Path:
    return Path.home().resolve()


def _system_dirs() -> list[Path]:
    """The platform's system, program and credential folders (osplat), never sent from."""
    from .. import osplat

    return osplat.paths.system_dirs()


# Folders right under home that hold a user's own files; none is a workspace to send from.
USER_DATA_FOLDERS = frozenset({
    "desktop", "documents", "downloads", "pictures", "movies", "music", "videos", "library",
    "public", "onedrive", "dropbox", "icloud drive", "google drive", "applications",
})


def _too_broad(base: Path) -> bool:
    """A folder no pane may send from wholesale: a filesystem root or other shallow
    folder (/Users, /Volumes, /opt), a mount point, the home folder or one above it, or
    one of the user-data folders right under home (Desktop, Documents, Downloads ...)."""
    if base == type(base)(base.anchor) or len(base.parts) < 3 or os.path.ismount(base):
        return True
    home = _home()
    if _inside(home, base):  # home itself or a folder above it
        return True
    return _folded(base.parent) == _folded(home) and base.name.casefold() in USER_DATA_FOLDERS


def _scope(real: Path) -> tuple[str, ...]:
    """The segments of ``real`` the name rules judge: everything below home (or below the
    anchor, outside home), so a workspace that itself sits in ~/.ssh or a secrets/ folder
    is caught, not only what lies below the workspace."""
    home = _home()
    return real.parts[len(home.parts):] if _inside(real, home) else real.parts[1:]


def _folded(path: PurePath) -> tuple[str, ...]:
    return tuple(part.casefold() for part in path.parts)


def _inside(path: PurePath, folder: PurePath) -> bool:
    """``path`` is ``folder`` or below it, ignoring case: APFS and NTFS volumes are
    case-insensitive, so /Users/me/library/keychains is ~/Library/Keychains. Used only
    where a match refuses; where a match admits (the workspace), case must agree."""
    inner, outer = _folded(path), _folded(folder)
    return inner[: len(outer)] == outer


def resolve_outbound(raw: str, roots: list[str | Path]) -> tuple[Path | None, str]:
    """(the real file, "") when a pane may send ``raw``, else (None, reason): one of
    not_absolute, parent_ref, missing, not_file, outside, broad_workspace, hidden,
    denied_name, system, hard_link."""
    real, _st, reason = _check(raw, roots)
    return real, reason


def _check(raw: str, roots: list[str | Path]) -> tuple[Path | None, os.stat_result | None, str]:
    """``resolve_outbound`` plus the stat of the very inode that passed the rules."""
    path = Path(raw.strip())
    if not path.is_absolute():
        return None, None, "not_absolute"
    if ".." in path.parts:
        return None, None, "parent_ref"
    # "name:stream" opens an NTFS alternate data stream; no colon below the anchor anywhere.
    if any(":" in part for part in path.parts[1:]):
        return None, None, "denied_name"
    try:
        real = path.resolve(strict=True)
    except (OSError, RuntimeError):
        return None, None, "missing"
    if not real.is_file():
        return None, None, "not_file"
    in_broad = False
    for root in roots:
        if not root:
            continue
        try:
            base = Path(root).resolve(strict=True)
        except (OSError, RuntimeError):
            continue
        if not real.is_relative_to(base):
            continue
        if _too_broad(base):
            in_broad = True  # never usable; a narrower root later may still admit the file
            continue
        scope = _scope(real)
        if any(part.startswith(".") for part in scope):
            return None, None, "hidden"
        # A colon can also arrive through a symlink, after the raw path passed.
        if any(":" in part for part in scope) or any(
                fnmatch.fnmatch(part.lower(), pat) for part in scope for pat in DENIED_NAMES):
            return None, None, "denied_name"
        if any(_within(real, s) for s in _system_dirs()):
            return None, None, "system"
        st = real.stat()
        # A second name for the same inode may be a file from anywhere on the disk.
        if st.st_nlink > 1:
            return None, None, "hard_link"
        return real, st, ""
    return None, None, "broad_workspace" if in_broad else "outside"


def _within(path: Path, folder: Path) -> bool:
    """``path`` is ``folder`` or inside it, after resolving the folder too (so /etc and
    /private/etc agree on macOS). Windows paths compare case-insensitively."""
    try:
        folder = folder.resolve()
    except (OSError, RuntimeError):
        pass
    return _inside(path, folder)


@dataclass
class Outbound:
    fh: BinaryIO  # the checked file, already open; the caller closes it
    path: Path
    size: int


def open_outbound(raw: str, roots: list[str | Path]) -> tuple[Outbound | None, str]:
    """``resolve_outbound``, then open the file so what is sent is what was checked.

    The open file must be the inode the check saw (a file swapped in afterwards), with one
    link, and the path must still resolve to itself (a folder swapped for a symlink). The
    last component is also opened without following a symlink, a second guard the realpath
    check already covers. Any difference is reason "changed".
    """
    real, seen, reason = _check(raw, roots)
    if real is None or seen is None:
        return None, reason
    try:
        fd = os.open(real, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    except OSError:
        return None, "changed"
    try:
        st = os.fstat(fd)
        same = (st.st_dev, st.st_ino) == (seen.st_dev, seen.st_ino)
        if not (same and stat.S_ISREG(st.st_mode) and st.st_nlink == 1
                and Path(os.path.realpath(real)) == real):
            os.close(fd)
            return None, "changed"
    except OSError:
        os.close(fd)
        return None, "changed"
    return Outbound(os.fdopen(fd, "rb"), real, st.st_size), ""


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
        "reason.broad_workspace": "這個 pane 的 workspace 是家目錄或範圍過大的資料夾，不從那裡傳檔",
        "reason.hard_link": "這個檔案有其他硬連結，可能是 workspace 外的檔案",
        "reason.changed": "檢查後檔案被更動或換成連結",
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
        "reason.broad_workspace": "this pane's workspace is the home folder or another folder too broad to send from",
        "reason.hard_link": "the file has other hard links and may be a file from outside the workspace",
        "reason.changed": "the file changed or became a link after it was checked",
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
        "reason.broad_workspace": "この pane の workspace はホームフォルダか範囲が広すぎるフォルダなので、そこからは送信しません",
        "reason.hard_link": "このファイルには別のハードリンクがあり、workspace 外のファイルの可能性があります",
        "reason.changed": "確認した後にファイルが変更されたか、リンクに置き換えられました",
    },
}
DEFAULT_LANGUAGE = "zh-TW"


def text(lang: str, key: str, **kw: object) -> str:
    return STRINGS.get(lang, STRINGS[DEFAULT_LANGUAGE])[key].format(**kw)


def attachment_line(kind: str, name: str, size: int, path: Path) -> str:
    """What the pane is told about one received file."""
    return f"[附件] {kind} {name} {human_size(size)} → {path}"
