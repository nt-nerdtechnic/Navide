"""channels.media: inbound storage and which files a pane may send to a chat."""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

from agent_team_backend.channels import media

from agent_team_backend import osplat

# Windows creates symlinks only with Developer Mode or elevation.
needs_symlinks = pytest.mark.skipif(not osplat.paths.symlinks_available(),
                                    reason="this Windows session may not create symlinks")


def _file(path: Path, data: bytes = b"x") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# --- inbound names and folders ------------------------------------------------------


@pytest.mark.parametrize("name, expected", [
    ("report.pdf", "report.pdf"),
    ("../../etc/passwd", "passwd"),
    ("..\\..\\win.ini", "win.ini"),
    (".env", "env"),
    ("我的 檔案 (1).png", "1.png"),
    ("報告.pdf", "file.pdf"),
    ("a\nb\x1bc.txt", "a_b_c.txt"),
    ("x" * 300 + ".txt", "x" * media.NAME_MAX_CHARS + ".txt"),
    ("evil.p\nng", "evil.png"),
])
def test_safe_name_keeps_only_safe_characters(name: str, expected: str) -> None:
    assert media.safe_name(name) == expected


def test_safe_name_falls_back_to_the_kind_and_mime() -> None:
    assert media.safe_name("", "photo") == "photo.jpg"
    assert media.safe_name("", "document", "application/pdf") == "file.pdf"
    assert media.safe_name("...", "voice") == "voice.ogg"


def test_inbound_path_is_per_pane_with_a_random_prefix(tmp_path: Path) -> None:
    a = media.new_inbound_path(tmp_path, "../pane:1", "a.png")
    b = media.new_inbound_path(tmp_path, "../pane:1", "a.png")
    assert a.parent == b.parent == media.pane_dir(tmp_path, "../pane:1") == tmp_path / "pane_1" and a != b
    assert a.name.endswith("-a.png") and len(a.name) == len("abcd1234-a.png")


@needs_symlinks
def test_prune_removes_old_files_symlinks_and_empty_folders(tmp_path: Path) -> None:
    now = time.time()
    old = _file(tmp_path / "p1" / "old.png")
    os.utime(old, (now - media.RETENTION_S - 10, now - media.RETENTION_S - 10))
    fresh = _file(tmp_path / "p2" / "fresh.png")
    outside = _file(tmp_path.parent / f"{tmp_path.name}-keep" / "secret.txt")
    (tmp_path / "p2" / "link").symlink_to(outside)
    assert media.prune(tmp_path, now) == 2
    assert not (tmp_path / "p1").exists() and fresh.exists() and outside.exists()
    assert not (tmp_path / "p2" / "link").is_symlink()


# --- outbound syntax ----------------------------------------------------------------


def test_split_attachments_takes_marker_lines_outside_fences() -> None:
    body = "here you go\n---ATTACH--- /w/a.png\n```\n---ATTACH--- /w/not.png\n```\n---ATTACH---   /w/b c.pdf  "
    text, paths = media.split_attachments(body)
    assert paths == ["/w/a.png", "/w/b c.pdf"]
    assert text == "here you go\n```\n---ATTACH--- /w/not.png\n```"


def test_split_attachments_ignores_indented_or_inline_markers() -> None:
    body = "  ---ATTACH--- /w/a.png\nsee ---ATTACH--- /w/b.png\n---ATTACH---"
    assert media.split_attachments(body) == (body, [])


# --- outbound path rules ------------------------------------------------------------


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    _file(root / "out" / "chart.png")
    return root


def test_a_workspace_file_is_allowed(ws: Path) -> None:
    assert media.resolve_outbound(str(ws / "out" / "chart.png"), [ws]) == ((ws / "out" / "chart.png").resolve(), "")


def test_the_media_folder_is_allowed(tmp_path: Path, ws: Path) -> None:
    root = tmp_path / "media"
    f = _file(root / "pane" / "abcd-a.png")
    assert media.resolve_outbound(str(f), [ws, root]) == (f.resolve(), "")


@pytest.mark.parametrize("raw, reason", [
    ("out/chart.png", "not_absolute"),
    ("{ws}/out/../out/chart.png", "parent_ref"),
    ("{ws}/out/missing.png", "missing"),
    ("{ws}/out", "not_file"),
    ("{outside}", "outside"),
])
def test_paths_outside_the_rules_are_refused(tmp_path: Path, ws: Path, raw: str, reason: str) -> None:
    outside = _file(tmp_path / "elsewhere" / "x.txt")
    raw = raw.format(ws=ws, outside=outside)
    assert media.resolve_outbound(raw, [ws]) == (None, reason)


@needs_symlinks
def test_a_symlink_out_of_the_workspace_is_judged_by_its_target(tmp_path: Path, ws: Path) -> None:
    secret = _file(tmp_path / "home" / "notes.txt")
    (ws / "out" / "notes.txt").symlink_to(secret)
    (ws / "linkdir").symlink_to(tmp_path / "home", target_is_directory=True)
    assert media.resolve_outbound(str(ws / "out" / "notes.txt"), [ws]) == (None, "outside")
    assert media.resolve_outbound(str(ws / "linkdir" / "notes.txt"), [ws]) == (None, "outside")


@needs_symlinks
def test_a_symlink_into_a_dotfolder_is_refused(ws: Path) -> None:
    key = _file(ws / ".ssh" / "config")
    (ws / "out" / "cfg").symlink_to(key)
    assert media.resolve_outbound(str(ws / "out" / "cfg"), [ws]) == (None, "hidden")


@pytest.mark.parametrize("rel", [".env", ".git/config", ".aws/credentials", "sub/.npmrc"])
def test_dotfiles_and_dotfolders_are_refused(ws: Path, rel: str) -> None:
    f = _file(ws / rel)
    assert media.resolve_outbound(str(f), [ws]) == (None, "hidden")


@pytest.mark.parametrize("name", ["server.pem", "PRIVATE.KEY", "id_rsa", "id_ed25519.pub", "credentials",
                                  "credentials.json", "cert.p12", "vault.kdbx", "terraform.tfstate"])
def test_credential_shaped_names_are_refused(ws: Path, name: str) -> None:
    f = _file(ws / "keys" / name)
    assert media.resolve_outbound(str(f), [ws]) == (None, "denied_name")


def test_a_filesystem_root_is_never_a_workspace(ws: Path) -> None:
    f = ws / "out" / "chart.png"
    assert media.resolve_outbound(str(f), [Path(f.resolve().anchor)]) == (None, "broad_workspace")


def test_system_folders_are_refused_inside_a_workspace(tmp_path: Path, monkeypatch) -> None:
    f = _file(tmp_path / "deep" / "sys" / "hosts")
    monkeypatch.setattr(media, "_system_dirs", lambda: [tmp_path / "deep" / "sys"])
    assert media.resolve_outbound(str(f), [tmp_path / "deep"]) == (None, "system")


def test_the_platforms_system_dirs_are_used() -> None:
    from agent_team_backend import osplat

    assert media._system_dirs() == osplat.paths.system_dirs()


@pytest.mark.parametrize("suffix", [":secret", ":secret:$DATA", "::$DATA"])
def test_an_alternate_data_stream_is_refused(ws: Path, suffix: str) -> None:
    """NTFS reads ``file:stream`` as a hidden stream of the file; a colon is refused
    below the anchor everywhere, before the path is resolved."""
    assert media.resolve_outbound(str(ws / "out" / "chart.png") + suffix, [ws]) == (None, "denied_name")


@pytest.mark.parametrize("raw", ["C:foo\\bar.txt", "\\foo\\bar.txt", "out/chart.png", "~/chart.png"])
def test_relative_and_drive_relative_paths_are_refused(ws: Path, raw: str) -> None:
    assert media.resolve_outbound(raw, [ws]) == (None, "not_absolute")


def test_a_unc_share_root_is_too_broad(monkeypatch) -> None:
    from pathlib import PureWindowsPath

    monkeypatch.setattr(media, "_home", lambda: PureWindowsPath(r"C:\Users\me"))
    assert media._too_broad(PureWindowsPath("\\\\server\\share\\"))
    assert media._too_broad(PureWindowsPath("\\\\server\\share\\team"))
    assert not media._too_broad(PureWindowsPath("\\\\server\\share\\team\\app"))


@pytest.mark.skipif(sys.platform != "win32", reason="8.3 short names exist only on Windows (NTFS)")
def test_a_short_name_cannot_hide_a_denied_folder(ws: Path) -> None:
    import ctypes

    f = _file(ws / "credentials_store" / "notes.txt")
    buf = ctypes.create_unicode_buffer(1024)
    ctypes.windll.kernel32.GetShortPathNameW(str(f.parent), buf, 1024)
    if not buf.value or Path(buf.value).name.lower() == "credentials_store":
        pytest.skip("8.3 name generation is off on this volume")
    assert media.resolve_outbound(str(Path(buf.value) / "notes.txt"), [ws]) == (None, "denied_name")


def test_human_size() -> None:
    assert [media.human_size(n) for n in (5, 2048, 3 * 1024 * 1024)] == ["5 B", "2 KB", "3 MB"]
    assert media.human_size(1536) == "1.5 KB"


def test_every_language_has_every_notice() -> None:
    keys = set(media.STRINGS[media.DEFAULT_LANGUAGE])
    assert all(set(table) == keys for table in media.STRINGS.values())
    assert set(media.STRINGS) == {"zh-TW", "en-US", "ja-JP"}


# --- Hardening: broad workspaces, every path segment, links and swaps -----------------


@pytest.fixture
def home(tmp_path: Path, monkeypatch) -> Path:
    root = tmp_path / "Users" / "me"
    _file(root / "Documents" / "tax.pdf")
    monkeypatch.setattr(media, "_home", lambda: root)
    return root


def test_a_home_workspace_sends_nothing(home: Path) -> None:
    assert media.resolve_outbound(str(home / "Documents" / "tax.pdf"), [home]) == (None, "broad_workspace")


def test_a_workspace_above_home_sends_nothing(home: Path) -> None:
    assert media.resolve_outbound(str(home / "Documents" / "tax.pdf"), [home.parent]) == (None, "broad_workspace")


def test_a_project_inside_home_and_the_media_folder_still_work(home: Path) -> None:
    proj = _file(home / "code" / "app" / "out.png")
    pane = _file(home / "Library" / "Agent-Team" / "channels-media" / "pane-1" / "ab-x.png")
    assert media.resolve_outbound(str(proj), [home / "code" / "app"]) == (proj.resolve(), "")
    assert media.resolve_outbound(str(pane), [home, pane.parent]) == (pane.resolve(), "")


@pytest.mark.parametrize("path", ["/", "/Users", "/Volumes", "/home", "/opt"])
def test_shallow_folders_are_too_broad(path: str) -> None:
    assert media._too_broad(Path(path))


@pytest.mark.parametrize("rel", [
    "secrets/notes.txt", "credentials/aws.txt", "config/prod.env", "api_token.txt", "keys/server.ppk",
    "Chrome/Default/Cookies", "Chrome/Default/Login Data", "data/app.sqlite", "data/app.sqlite3",
    "my_password.txt", "backup.gpg", "Keychains/login.keychain-db",
])
def test_credential_shaped_names_are_refused_in_any_segment(ws: Path, rel: str) -> None:
    f = _file(ws / rel)
    assert media.resolve_outbound(str(f), [ws]) == (None, "denied_name")


def test_a_hard_link_to_another_file_is_refused(tmp_path: Path, ws: Path) -> None:
    outside = _file(tmp_path / "elsewhere" / "secret.txt", b"S")
    os.link(outside, ws / "out" / "copy.txt")
    assert media.resolve_outbound(str(ws / "out" / "copy.txt"), [ws]) == (None, "hard_link")


def test_open_outbound_reads_the_checked_file(ws: Path) -> None:
    opened, reason = media.open_outbound(str(ws / "out" / "chart.png"), [ws])
    assert reason == "" and opened is not None
    with opened.fh:
        assert (opened.fh.read(), opened.size, opened.path.name) == (b"x", 1, "chart.png")


@needs_symlinks
def test_a_file_swapped_for_a_symlink_after_the_check_is_not_opened(tmp_path: Path, ws: Path,
                                                                     monkeypatch) -> None:
    secret = _file(tmp_path / "elsewhere" / "secret.txt", b"SECRET")
    target = ws / "out" / "chart.png"
    checked = media._check

    def racing(raw, roots):
        result = checked(raw, roots)
        target.unlink()
        target.symlink_to(secret)  # swapped between the check and the open
        return result

    monkeypatch.setattr(media, "_check", racing)
    assert media.open_outbound(str(target), [ws]) == (None, "changed")


@needs_symlinks
def test_a_folder_swapped_for_a_symlink_after_the_check_is_not_opened(tmp_path: Path, ws: Path,
                                                                       monkeypatch) -> None:
    _file(tmp_path / "elsewhere" / "chart.png", b"SECRET")
    checked = media._check

    def racing(raw, roots):
        result = checked(raw, roots)
        (ws / "out").rename(ws / "moved")
        (ws / "out").symlink_to(tmp_path / "elsewhere", target_is_directory=True)
        return result

    monkeypatch.setattr(media, "_check", racing)
    assert media.open_outbound(str(ws / "out" / "chart.png"), [ws]) == (None, "changed")


def test_an_inbound_path_never_leaves_the_pane_folder(tmp_path: Path) -> None:
    for name in ("../../x", "..\\..\\y", "/etc/passwd", "a/../../b", "\x00z"):
        dest = media.new_inbound_path(tmp_path, "pane-1", media.safe_name(name))
        assert dest.parent == media.pane_dir(tmp_path, "pane-1")


def test_a_different_file_swapped_in_after_the_check_is_not_opened(ws: Path, monkeypatch) -> None:
    target = ws / "out" / "chart.png"
    checked = media._check

    def racing(raw, roots):
        result = checked(raw, roots)
        target.unlink()
        target.write_bytes(b"OTHER")  # a new inode under the same, still-real path
        return result

    monkeypatch.setattr(media, "_check", racing)
    assert media.open_outbound(str(target), [ws]) == (None, "changed")


# --- Review 2: user-data folders, the root's own path, resolved colons -----------------


@pytest.mark.parametrize("folder", ["Desktop", "Documents", "Downloads", "Pictures", "Library", "OneDrive"])
def test_a_user_data_folder_as_workspace_is_too_broad(home: Path, folder: str) -> None:
    f = _file(home / folder / "report.pdf")
    assert media.resolve_outbound(str(f), [home / folder]) == (None, "broad_workspace")


def test_a_project_under_desktop_still_works(home: Path) -> None:
    f = _file(home / "Desktop" / "app" / "out.png")
    assert media.resolve_outbound(str(f), [home / "Desktop" / "app"]) == (f.resolve(), "")


@pytest.mark.parametrize("parent, reason", [(".ssh", "hidden"), (".aws/profile", "hidden"),
                                            ("secrets", "denied_name"), ("work/credentials", "denied_name")])
def test_a_workspace_inside_a_hidden_or_secret_folder_sends_nothing(home: Path, parent: str, reason: str) -> None:
    root = home / "code" / parent / "proj"
    f = _file(root / "notes.txt")
    assert media.resolve_outbound(str(f), [root]) == (None, reason)


@needs_symlinks
def test_a_colon_reached_through_a_symlink_is_refused(ws: Path) -> None:
    target = ws / "out" / "a:b.txt"
    try:
        target.write_text("x")
    except OSError:
        pytest.skip("this filesystem cannot name a file with a colon")
    (ws / "out" / "plain.txt").symlink_to(target)
    assert media.resolve_outbound(str(ws / "out" / "plain.txt"), [ws]) == (None, "denied_name")
