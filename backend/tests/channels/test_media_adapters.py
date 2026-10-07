"""Telegram, Discord and Slack: reading a message's files, downloading them and sending
files, against httpx mock transports shaped like each platform's documented API."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from agent_team_backend.channels.base import (
    ChannelSendError, InboundAttachment, InboundMessage, Location, MediaTooLarge,
)
from agent_team_backend.channels.discord import DiscordAdapter
from agent_team_backend.channels.slack import SlackAdapter
from agent_team_backend.channels.telegram import TelegramAdapter

TOKEN = "123:abc"
MB = 1024 * 1024


def _collect(adapter: Any) -> list[InboundMessage]:
    got: list[InboundMessage] = []

    async def emit(msg: InboundMessage) -> None:
        got.append(msg)

    adapter._emit = emit
    return got


class Recorder:
    """A mock transport that records requests and answers from a route table."""

    def __init__(self, routes: dict[str, Any]) -> None:
        self.routes = routes
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for key, answer in self.routes.items():
            if key in str(request.url):
                return answer(request) if callable(answer) else answer
        return httpx.Response(404, json={"ok": False, "description": "no route"})

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self)


def _form(request: httpx.Request) -> bytes:
    return request.read()


# --- Telegram -----------------------------------------------------------------------


def _tg(**msg: Any) -> dict[str, Any]:
    base = {"message_id": 5, "date": 1, "chat": {"id": 42, "type": "private"},
            "from": {"id": 7, "username": "alice"}}
    return {"update_id": 1, "message": {**base, **msg}}


async def test_telegram_reads_the_largest_photo_and_other_file_kinds() -> None:
    ad = TelegramAdapter(TOKEN)
    got = _collect(ad)
    await ad._handle_update(_tg(caption="look", photo=[
        {"file_id": "small", "file_size": 10}, {"file_id": "big", "file_size": 900}]))
    await ad._handle_update(_tg(document={"file_id": "d1", "file_name": "r.pdf", "mime_type": "application/pdf",
                                          "file_size": 2000}))
    await ad._handle_update(_tg(voice={"file_id": "v1", "mime_type": "audio/ogg", "file_size": 30}))
    await ad._handle_update(_tg(animation={"file_id": "a1", "file_name": "x.mp4", "mime_type": "video/mp4"},
                                document={"file_id": "a1", "file_name": "x.mp4", "mime_type": "video/mp4"}))
    await ad._handle_update(_tg(sticker={"file_id": "s1"}))  # no text, no file we take: skipped
    assert [m.text for m in got] == ["look", "", "", ""]
    assert [m.attachments for m in got] == [
        [InboundAttachment("photo", "", 900, "image/jpeg", "big")],
        [InboundAttachment("document", "r.pdf", 2000, "application/pdf", "d1")],
        [InboundAttachment("voice", "", 30, "audio/ogg", "v1")],
        [InboundAttachment("animation", "x.mp4", None, "video/mp4", "a1")],
    ]


async def test_telegram_downloads_through_getfile(tmp_path: Path) -> None:
    rec = Recorder({
        "/getFile": httpx.Response(200, json={"ok": True, "result": {"file_path": "photos/f.jpg", "file_size": 4}}),
        "/file/bot123:abc/photos/f.jpg": httpx.Response(200, content=b"JPEG"),
    })
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._client = httpx.AsyncClient(transport=rec.transport())
    ad._media_transport = rec.transport()
    dest = tmp_path / "f.jpg"
    size = await ad.download(InboundAttachment("photo", "", 4, "image/jpeg", "big"), dest, 100)
    assert size == 4 and dest.read_bytes() == b"JPEG"
    assert json.loads(rec.requests[0].content) == {"file_id": "big"}
    assert str(rec.requests[1].url) == "https://tg.test/file/bot123:abc/photos/f.jpg"


async def test_telegram_download_past_the_cap_leaves_no_file(tmp_path: Path) -> None:
    rec = Recorder({
        "/getFile": httpx.Response(200, json={"ok": True, "result": {"file_path": "d/f.bin"}}),
        "/file/": httpx.Response(200, content=b"x" * 50),
    })
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._client = httpx.AsyncClient(transport=rec.transport())
    ad._media_transport = rec.transport()
    dest = tmp_path / "f.bin"
    with pytest.raises(MediaTooLarge):
        await ad.download(InboundAttachment("document", "f.bin", None, "", "d"), dest, 10)
    assert not dest.exists()


async def test_a_download_without_a_length_is_counted_against_the_cap(tmp_path: Path) -> None:
    async def body():
        for _ in range(5):
            yield b"x" * 10

    rec = Recorder({
        "/getFile": httpx.Response(200, json={"ok": True, "result": {"file_path": "d/f.bin"}}),
        "/file/": lambda _req: httpx.Response(200, content=body()),
    })
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._client = httpx.AsyncClient(transport=rec.transport())
    ad._media_transport = rec.transport()
    dest = tmp_path / "f.bin"
    with pytest.raises(MediaTooLarge):
        await ad.download(InboundAttachment("document", "f.bin", None, "", "d"), dest, 25)
    assert not dest.exists()


@pytest.mark.parametrize("file_path", ["/var/lib/telegram-bot-api/x.jpg", "../x.jpg", ""])
async def test_telegram_refuses_odd_file_paths(tmp_path: Path, file_path: str) -> None:
    rec = Recorder({"/getFile": httpx.Response(200, json={"ok": True, "result": {"file_path": file_path}})})
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._client = httpx.AsyncClient(transport=rec.transport())
    ad._media_transport = rec.transport()
    with pytest.raises(ChannelSendError):
        await ad.download(InboundAttachment("photo", "", None, "", "x"), tmp_path / "x", 100)
    assert len(rec.requests) == 1


async def test_telegram_sends_a_document_to_the_topic(tmp_path: Path) -> None:
    f = tmp_path / "chart.png"
    f.write_bytes(b"PNG")
    rec = Recorder({"/sendDocument": httpx.Response(200, json={"ok": True, "result": {"message_id": 77}})})
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._media_transport = rec.transport()
    ids = await ad.send_file(Location("telegram", "default", "-100", "50"), f, "chart.png")
    body = _form(rec.requests[0])
    assert ids == ["77"] and b'name="chat_id"\r\n\r\n-100' in body
    assert b'name="message_thread_id"\r\n\r\n50' in body
    assert b'name="document"; filename="chart.png"' in body and b"PNG" in body
    assert ad.upload_max_bytes == 50 * MB


async def test_telegram_send_error_is_a_send_error(tmp_path: Path) -> None:
    f = tmp_path / "a.txt"
    f.write_bytes(b"x")
    rec = Recorder({"/sendDocument": httpx.Response(400, json={"ok": False, "error_code": 400,
                                                                "description": "Bad Request: file is too big"})})
    ad = TelegramAdapter(TOKEN, base_url="https://tg.test")
    ad._media_transport = rec.transport()
    with pytest.raises(ChannelSendError, match="too big"):
        await ad.send_file(Location("telegram", "default", "42"), f, "a.txt")


# --- Discord ------------------------------------------------------------------------


def _discord() -> DiscordAdapter:
    ad = DiscordAdapter("tok")
    ad._bot_id = "bot"
    ad._parents["C1"] = ""
    return ad


async def test_discord_reads_attachments_and_emits_a_file_only_message() -> None:
    ad = _discord()
    got = _collect(ad)
    await ad._on_message({"id": "m1", "channel_id": "C1", "guild_id": "g", "type": 0, "content": "",
                          "author": {"id": "42", "username": "a"},
                          "attachments": [
                              {"id": "1", "filename": "a.png", "size": 10, "content_type": "image/png",
                               "url": "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"},
                              {"id": "2", "filename": "b.zip", "size": 20,
                               "url": "https://cdn.discordapp.com/attachments/1/3/b.zip"}]})
    assert got[0].attachments == [
        InboundAttachment("photo", "a.png", 10, "image/png", "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"),
        InboundAttachment("document", "b.zip", 20, "", "https://cdn.discordapp.com/attachments/1/3/b.zip"),
    ]


async def test_discord_download_never_sends_the_bot_token(tmp_path: Path) -> None:
    rec = Recorder({"cdn.discordapp.com": httpx.Response(200, content=b"PNG")})
    ad = _discord()
    ad._media_transport = rec.transport()
    url = "https://cdn.discordapp.com/attachments/1/2/a.png?ex=1"
    assert await ad.download(InboundAttachment("photo", "a.png", 3, "image/png", url), tmp_path / "a", 10) == 3
    assert "authorization" not in {k.lower() for k in rec.requests[0].headers}


@pytest.mark.parametrize("url", ["http://cdn.discordapp.com/a.png", "https://evil.example/a.png",
                                 "https://cdn.discordapp.com.evil.example/a.png"])
async def test_discord_refuses_urls_off_its_cdn(tmp_path: Path, url: str) -> None:
    rec = Recorder({"": httpx.Response(200, content=b"x")})
    ad = _discord()
    ad._media_transport = rec.transport()
    with pytest.raises(ChannelSendError):
        await ad.download(InboundAttachment("photo", "a.png", 1, "", url), tmp_path / "a", 10)
    assert rec.requests == []


async def test_discord_sends_a_file_as_a_multipart_attachment(tmp_path: Path) -> None:
    f = tmp_path / "chart.png"
    f.write_bytes(b"PNG")
    rec = Recorder({"/channels/T9/messages": httpx.Response(200, json={"id": "m77"})})
    ad = _discord()
    ad._client = httpx.AsyncClient(base_url="https://discord.test/api/v10", transport=rec.transport(),
                                   headers={"Authorization": "Bot tok"})
    ids = await ad.send_file(Location("discord", "default", "C1", "T9"), f, "chart.png")
    body = _form(rec.requests[0])
    assert ids == ["m77"] and b'name="files[0]"; filename="chart.png"' in body
    payload = body.split(b'name="payload_json"\r\n\r\n', 1)[1].split(b"\r\n--", 1)[0]
    assert json.loads(payload)["attachments"] == [{"id": 0, "filename": "chart.png"}]
    assert ad.upload_max_bytes == 20 * MB


# --- Slack --------------------------------------------------------------------------


def _slack() -> SlackAdapter:
    ad = SlackAdapter("xapp-1", "xoxb-1")
    ad._user_id = "UBOT"
    ad._names["U1"] = "alice"
    return ad


async def test_slack_reads_shared_files() -> None:
    ad = _slack()
    got = _collect(ad)
    await ad._on_event({"type": "message", "subtype": "file_share", "channel": "C1", "user": "U1", "ts": "1.1",
                        "text": "", "channel_type": "channel", "files": [
                            {"id": "F1", "name": "a.png", "mimetype": "image/png", "size": 9,
                             "url_private_download": "https://files.slack.com/files-pri/T-F1/download/a.png"},
                            {"id": "F2", "mode": "tombstone"},
                            {"id": "F3", "name": "g.doc", "is_external": True,
                             "url_private": "https://docs.google.com/x"}]})
    assert got[0].attachments == [
        InboundAttachment("photo", "a.png", 9, "image/png", "https://files.slack.com/files-pri/T-F1/download/a.png")]


async def test_slack_download_sends_the_bot_token_only_to_slack(tmp_path: Path) -> None:
    rec = Recorder({"files.slack.com": httpx.Response(200, content=b"PNG",
                                                      headers={"content-type": "image/png"})})
    ad = _slack()
    ad._media_transport = rec.transport()
    url = "https://files.slack.com/files-pri/T-F1/download/a.png"
    assert await ad.download(InboundAttachment("photo", "a.png", 3, "image/png", url), tmp_path / "a", 10) == 3
    assert rec.requests[0].headers["authorization"] == "Bearer xoxb-1"
    with pytest.raises(ChannelSendError):
        await ad.download(InboundAttachment("photo", "a.png", 3, "", "https://evil.example/a.png"),
                          tmp_path / "b", 10)
    assert len(rec.requests) == 1


async def test_slack_download_without_files_read_says_so(tmp_path: Path) -> None:
    rec = Recorder({"files.slack.com": httpx.Response(302, headers={"location": "https://slack.com/signin"})})
    ad = _slack()
    ad._media_transport = rec.transport()
    with pytest.raises(ChannelSendError, match="files:read"):
        await ad.download(InboundAttachment("photo", "a.png", 3, "", "https://files.slack.com/x"), tmp_path / "a", 10)


async def test_slack_upload_uses_the_external_upload_flow(tmp_path: Path) -> None:
    f = tmp_path / "chart.png"
    f.write_bytes(b"PNG")
    rec = Recorder({
        "files.getUploadURLExternal": httpx.Response(200, json={
            "ok": True, "upload_url": "https://files.slack.com/upload/v1/abc", "file_id": "F9"}),
        "/upload/v1/abc": httpx.Response(200, text="OK - 3"),
        "files.completeUploadExternal": httpx.Response(200, json={"ok": True, "files": [{"id": "F9"}]}),
    })
    ad = _slack()
    ad._client = httpx.AsyncClient(base_url="https://slack.test/api", transport=rec.transport())
    ad._media_transport = rec.transport()
    ids = await ad.send_file(Location("slack", "default", "C1", "9.0"), f, "chart.png")
    first, upload, done = rec.requests
    assert ids == ["F9"]
    assert b"filename=chart.png" in first.content and b"length=3" in first.content
    assert upload.read() == b"PNG" and "authorization" not in {k.lower() for k in upload.headers}
    assert json.loads(done.content) == {"files": [{"id": "F9", "title": "chart.png"}], "channel_id": "C1",
                                        "thread_ts": "9.0"}
    assert ad.upload_max_bytes == 1024 * MB
