"""The manager's side of chat attachments: what is downloaded, what the pane is told,
and which files a pane's reply may send."""

from __future__ import annotations

import dataclasses
import time
from pathlib import Path

import pytest

from agent_team_backend.channels import media
from agent_team_backend.channels.base import (
    ChannelSendError, InboundAttachment, InboundMessage, Location, MediaTooLarge,
)

from .test_manager import _MIDS, Env, _armed, _said, _until, env, fast_timers  # noqa: F401 — fixtures


class Media:
    """Gives a FakeAdapter the MediaAdapter methods and records their use."""

    def __init__(self, adapter, upload_max: int = 50 * 1024 * 1024) -> None:
        self.downloads: list[tuple[InboundAttachment, Path, int]] = []
        self.files: list[tuple[Location, Path, str]] = []
        self.payload = b"PNGDATA"
        self.fail: Exception | None = None
        adapter.upload_max_bytes = upload_max
        adapter.download = self.download
        adapter.send_file = self.send_file

    async def download(self, att: InboundAttachment, dest: Path, max_bytes: int) -> int:
        self.downloads.append((att, dest, max_bytes))
        if self.fail is not None:
            raise self.fail
        dest.write_bytes(self.payload)
        return len(self.payload)

    async def send_file(self, loc: Location, path: Path, filename: str) -> list[str]:
        self.files.append((loc, path, filename))
        return ["f1"]


@pytest.fixture
def ws(tmp_path: Path) -> Path:
    root = tmp_path / "ws"
    (root / "out").mkdir(parents=True)
    (root / "out" / "chart.png").write_bytes(b"chart")
    return root


@pytest.fixture
def media_env(env: Env, tmp_path: Path, ws: Path) -> Env:
    env.m._seams = dataclasses.replace(env.m._seams, media_root=lambda: tmp_path / "media",
                                       pane_workspace=lambda _p: str(ws))
    return env


PHOTO = InboundAttachment(kind="photo", name="", size=1024, mime="image/jpeg", ref="file-1")


async def _send(env: Env, text: str, attachments: list[InboundAttachment], *, sender: str = "7",
                direct: bool = False, chat: str = "-100", thread: str = "50") -> None:
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id=chat, thread_id=thread, sender_id=sender,
        sender_name="alice", text=text, message_id=f"m{next(_MIDS)}", is_direct=direct, ts=time.time(),
        attachments=attachments))
    await env.m.wait_idle()


# --- inbound ------------------------------------------------------------------------


async def test_an_allowed_senders_photo_is_saved_and_named_to_the_pane(media_env: Env, tmp_path: Path) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "look at this", [PHOTO])
    (att, dest, cap), = m.downloads
    assert att == PHOTO and cap == media.INBOUND_MAX_BYTES
    assert dest.parent == tmp_path / "media" / "pane-1" and dest.name.endswith("-photo.jpg")
    assert media_env.fake.delivered[-1] == (
        "pane-1", f"look at this\n[附件] photo photo.jpg 7 B → {dest}", "telegram:alice")


async def test_an_attachment_alone_is_delivered(media_env: Env) -> None:
    m = Media(media_env.tg)
    doc = InboundAttachment(kind="document", name="../../report.pdf", size=None, mime="application/pdf", ref="f")
    await _send(media_env, "", [doc])
    dest = m.downloads[0][1]
    assert dest.name.endswith("-report.pdf")
    assert media_env.fake.delivered[-1][1] == f"[附件] document report.pdf 7 B → {dest}"


async def test_a_declared_oversize_file_is_not_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    big = dataclasses.replace(PHOTO, size=media.INBOUND_MAX_BYTES + 1)
    await _send(media_env, "big one", [big])
    assert m.downloads == []
    assert media_env.fake.delivered[-1][1] == "big one"
    assert _said(media_env, "20 MB")


async def test_a_download_that_runs_past_the_cap_is_refused(media_env: Env) -> None:
    m = Media(media_env.tg)
    m.fail = MediaTooLarge("over")
    await _send(media_env, "", [dataclasses.replace(PHOTO, size=None)])
    assert media_env.fake.delivered == [] and _said(media_env, "20 MB")


async def test_a_failed_download_is_reported_and_the_text_still_goes(media_env: Env) -> None:
    m = Media(media_env.tg)
    m.fail = ChannelSendError("HTTP 500")
    await _send(media_env, "caption", [PHOTO])
    assert media_env.fake.delivered[-1][1] == "caption" and _said(media_env, "HTTP 500")


async def test_a_platform_without_media_says_so(media_env: Env) -> None:
    await _send(media_env, "caption", [PHOTO])  # the plain FakeAdapter has no download
    assert media_env.fake.delivered[-1][1] == "caption"
    assert _said(media_env, "此平台尚不支援媒體")


async def test_a_group_strangers_file_is_never_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "hi", [PHOTO], sender="999")
    assert m.downloads == [] and media_env.fake.delivered == []


async def test_a_dm_strangers_file_is_never_downloaded(media_env: Env) -> None:
    m = Media(media_env.tg)
    await _send(media_env, "hi", [PHOTO], sender="998", direct=True, chat="998", thread="")
    assert m.downloads == [] and media_env.fake.delivered == []


async def test_old_media_is_pruned_when_a_new_file_arrives(media_env: Env, tmp_path: Path) -> None:
    old = tmp_path / "media" / "pane-9" / "abcd-old.png"
    old.parent.mkdir(parents=True)
    old.write_bytes(b"x")
    import os
    stale = time.time() - media.RETENTION_S - 60
    os.utime(old, (stale, stale))
    Media(media_env.tg)
    await _send(media_env, "", [PHOTO])
    assert not old.exists()


# --- outbound -----------------------------------------------------------------------


def _msg(body: str) -> str:
    return f"---MSG-START--- to: telegram:alice\n{body}\n---MSG-END---"


async def test_a_reply_sends_a_workspace_file(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"here it is\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    loc, path, name = m.files[0]
    assert (loc.chat_id, loc.thread_id, path, name) == ("-100", "50", (ws / "out" / "chart.png").resolve(),
                                                       "chart.png")
    assert _said(media_env, "here it is") and not _said(media_env, "ATTACH")


async def test_a_reply_with_only_a_file_posts_no_empty_text(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    before = len(media_env.tg.texts())
    media_env.turn_complete("pane-1", _msg(f"---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: m.files)
    await media_env.m.wait_idle()
    assert not any("沒有文字輸出" in t for t in media_env.tg.texts()[before:])


@pytest.mark.parametrize("target, reason", [
    ("/etc/hosts", "outside"),
    ("{ws}/.env", "hidden"),
    ("{ws}/out/../out/chart.png", "parent_ref"),
    ("{ws}/out/id_rsa", "denied_name"),
])
async def test_a_refused_file_is_not_sent_and_the_chat_hears_why(media_env: Env, ws: Path, target: str,
                                                                 reason: str) -> None:
    (ws / ".env").write_text("SECRET=1")
    (ws / "out" / "id_rsa").write_text("key")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"see file\n---ATTACH--- {target.format(ws=ws)}"))
    await _until(lambda: _said(media_env, "see file"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == [] and not _said(media_env, "SECRET")


async def test_a_symlink_to_a_secret_is_not_sent(media_env: Env, ws: Path, tmp_path: Path) -> None:
    secret = tmp_path / "secret.txt"
    secret.write_text("SECRET=1")
    (ws / "out" / "notes.txt").symlink_to(secret)
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"notes\n---ATTACH--- {ws}/out/notes.txt"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == []


async def test_a_file_over_the_platform_limit_is_not_sent(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg, upload_max=3)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"big\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == []


async def test_a_platform_without_media_tells_the_chat_instead_of_sending(media_env: Env, ws: Path) -> None:
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"file\n---ATTACH--- {ws}/out/chart.png"))
    await _until(lambda: _said(media_env, "此平台尚不支援媒體"))


async def test_attach_lines_outside_an_msg_block_are_never_honoured(media_env: Env, ws: Path) -> None:
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", f"plain turn\n---ATTACH--- {ws}/out/chart.png")
    await _until(lambda: _said(media_env, "plain turn"))
    await media_env.m.wait_idle()
    assert m.files == [] and not _said(media_env, "ATTACH")


async def test_a_reply_sends_the_panes_own_received_file(media_env: Env, tmp_path: Path) -> None:
    own = tmp_path / "media" / "pane-1" / "abcd1234-photo.jpg"
    own.parent.mkdir(parents=True)
    own.write_bytes(b"JPEG")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"back to you\n---ATTACH--- {own}"))
    await _until(lambda: m.files)
    assert m.files[0][1] == own.resolve()


async def test_another_panes_received_file_is_not_sent(media_env: Env, tmp_path: Path) -> None:
    """Each pane's media folder holds files from its own chat; sending another's leaks a chat."""
    theirs = tmp_path / "media" / "pane-2" / "abcd1234-secret.png"
    theirs.parent.mkdir(parents=True)
    theirs.write_bytes(b"PNG")
    m = Media(media_env.tg)
    await _armed(media_env)
    media_env.turn_complete("pane-1", _msg(f"leak\n---ATTACH--- {theirs}"))
    await _until(lambda: _said(media_env, "⚠️"))
    assert m.files == []
