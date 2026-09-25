from __future__ import annotations

import asyncio
import hashlib
import itertools
import time
from typing import Any

import pytest

from agent_team_backend.channels import manager as mgr_mod
from agent_team_backend.channels.base import AdapterStatus, Capabilities, InboundMessage, Location
from agent_team_backend.channels.manager import (
    MSG_INTERRUPTED,
    MSG_NOT_BOUND,
    MSG_RECEIVED_BUSY,
    MSG_WORKING,
    ChannelManager,
    Seams,
)
from agent_team_backend.channels.store import ChannelStore
from agent_team_backend.db import Database

# Unique per call: time.monotonic_ns() repeats within a ~15.6 ms tick on Windows.
_MIDS = itertools.count()


class FakeAdapter:
    capabilities = Capabilities(threads=True, create_location=True, edit=True, typing=True,
                                buttons=True, text_limit=4000)

    def __init__(self, platform: str, token: str) -> None:
        self.platform = platform
        self.account = "default"
        self.token = token
        self.status = AdapterStatus()
        self.sent: list[tuple[Location, str]] = []
        self.edits: list[tuple[str, str]] = []
        self.typing = 0
        self.fail_edits = False
        self.emit = None

    async def start(self, emit) -> None:
        self.emit = emit
        self.status.lifecycle = "ready"
        self.status.connected = True

    async def stop(self) -> None:
        self.status.lifecycle = "stopped"
        self.status.connected = False

    async def send_text(self, loc: Location, text: str, *, buttons=None) -> list[str]:
        self.sent.append((loc, text))
        return [str(len(self.sent))]

    async def edit_text(self, loc: Location, message_id: str, text: str) -> None:
        if self.fail_edits:
            self.edits.append((message_id, "FAILED"))
            raise RuntimeError("edit failed")
        self.edits.append((message_id, text))

    async def send_typing(self, loc: Location) -> None:
        self.typing += 1

    async def create_location(self, chat_id: str, title: str) -> Location:
        return Location(self.platform, self.account, chat_id, "77", title)

    def token_fingerprint(self) -> str:
        return hashlib.sha256(self.token.encode()).hexdigest()

    def texts(self) -> list[str]:
        return [t for _, t in self.sent]


class FakeSeams:
    def __init__(self) -> None:
        self.delivered: list[tuple[str, str, str]] = []
        self.verdicts: dict[str, dict[str, Any]] = {}
        self.interrupts: list[str] = []
        self.states: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, str] = {}
        self.events: list[tuple[str, dict[str, Any]]] = []
        self.secrets: dict[str, str | None] = {}
        self.kind = "permission"
        self.prompt = "Allow Bash(npm run build)?"
        self.options: list[str] = []
        self.gone: set[str] = set()
        self.answers: list[tuple[str, dict[str, Any]]] = []
        self.answer_result: dict[str, Any] = {"ok": True}
        self._n = 0

    async def deliver(self, pane_id: str, text: str, from_display: str) -> dict[str, Any]:
        self._n += 1
        self.delivered.append((pane_id, text, from_display))
        return {"ok": True, "msg_key": f"k{self._n}", "pane_id": pane_id}

    async def await_verdict(self, msg_key: str, timeout: float) -> dict[str, Any]:
        await asyncio.sleep(0.01)
        return self.verdicts.get(msg_key, {"status": "queued"})

    async def interrupt(self, pane_id: str) -> dict[str, Any]:
        self.interrupts.append(pane_id)
        return {"ok": True, "sent": True}

    def pane_state(self, pane_id: str) -> dict[str, Any]:
        return self.states.get(pane_id, {"exists": True, "busy": False, "display_status": "idle"})

    async def awaiting_info(self, pane_id: str) -> dict[str, Any]:
        return {"kind": self.kind, "prompt": self.prompt, "options": self.options}

    async def answer(self, pane_id: str, answer: dict[str, Any]) -> dict[str, Any]:
        self.answers.append((pane_id, answer))
        return self.answer_result

    def resolve_pane(self, pane_id: str) -> str:
        return "" if pane_id in self.gone else self.aliases.get(pane_id, pane_id)

    async def broadcast(self, event_type: str, payload: dict[str, Any]) -> None:
        self.events.append((event_type, payload))

    async def read_secret(self, name: str) -> str | None:
        return self.secrets.get(name)

    async def write_secret(self, name: str, secret: str | None) -> None:
        self.secrets[name] = secret

    def seams(self) -> Seams:
        return Seams(deliver=self.deliver, await_verdict=self.await_verdict, interrupt=self.interrupt,
                     pane_state=self.pane_state, awaiting_info=self.awaiting_info, answer=self.answer,
                     resolve_pane=self.resolve_pane, broadcast=self.broadcast,
                     read_secret=self.read_secret, write_secret=self.write_secret)


async def _until(pred, timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not pred():
        if time.monotonic() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(0.01)


@pytest.fixture(autouse=True)
def fast_timers(monkeypatch):
    monkeypatch.setattr(mgr_mod, "VERDICT_POLL_S", 0.01)
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.0)
    monkeypatch.setattr(mgr_mod, "TYPING_EVERY_S", 0.05)
    monkeypatch.setattr(mgr_mod, "STATUS_EDIT_EVERY_S", 0.05)
    monkeypatch.setattr(mgr_mod, "STATUS_EDIT_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(mgr_mod, "AWAITING_PROBE_EVERY_S", 0.02)
    monkeypatch.setattr(mgr_mod, "STATUS_POLL_S", 0.02)
    monkeypatch.setattr(mgr_mod, "RUN_TICK_S", 0.01)


class Env:
    def __init__(self, tmp_path, clock=time.monotonic) -> None:
        self.clock = clock
        self.db = Database(tmp_path / "navide.db")
        self.store = ChannelStore(self.db)
        self.fake = FakeSeams()
        self.adapters: dict[str, FakeAdapter] = {}

        def factory_for(platform: str):
            def build(config, secret, store):
                ad = FakeAdapter(platform, secret["token"])
                self.adapters[platform] = ad
                return ad
            return build

        self.m = ChannelManager(self.store, self.fake.seams(), factory_for=factory_for, clock=clock)

    @property
    def tg(self) -> FakeAdapter:
        return self.adapters["telegram"]

    async def inbound(self, text: str, *, sender: str = "7", chat: str = "-100", thread: str = "50",
                      direct: bool = False, mid: str | None = None, platform: str = "telegram",
                      wait: bool = True) -> None:
        mid = mid or f"m{next(_MIDS)}"
        await self.m.handle_inbound(InboundMessage(
            platform=platform, account="default", chat_id=chat, thread_id=thread, sender_id=sender,
            sender_name="alice", text=text, message_id=mid, is_direct=direct, ts=time.time()))
        if wait:
            await self.m.wait_idle()

    def turn_complete(self, pane_id: str, text: str) -> None:
        # A turn ending now ended after anything already armed. On Windows, CPython < 3.13's
        # monotonic clock ticks every ~15.6 ms, so a bare clock() can equal armed_at and the
        # manager would take this for the turn that was running when the message went in.
        self.m.on_pane_activity(pane_id, {"event_type": "turn_complete", "text": text,
                                          "ts_monotonic": self.clock() + 1e-6})


class FakeClock:
    def __init__(self) -> None:
        self.t = 1000.0

    def __call__(self) -> float:
        return self.t


async def _make_env(tmp_path, clock=time.monotonic) -> Env:
    e = Env(tmp_path, clock)
    await e.m.start()
    assert (await e.m.configure("telegram", {}, {"token": "tok-A"}))["ok"]
    e.store.add_allow("telegram", "7", "alice", 1)
    e.store.bind("pane-1", Location("telegram", "default", "-100", "50", "api"))
    return e


@pytest.fixture
async def env(tmp_path):
    e = await _make_env(tmp_path)
    yield e
    await e.m.stop()
    e.db.close()


@pytest.fixture
async def clocked(tmp_path):
    clock = FakeClock()
    e = await _make_env(tmp_path, clock)
    yield e, clock
    await e.m.stop()
    e.db.close()


async def test_configure_stores_single_line_secret_and_masks(env: Env) -> None:
    assert env.fake.secrets["channel-telegram"] == '{"token":"tok-A"}'
    listed = env.m.list()
    tg = next(p for p in listed["platforms"] if p["platform"] == "telegram")
    assert tg["configured"] and tg["enabled"] and tg["status"]["lifecycle"] == "ready"
    assert "tok-A" not in str(listed)
    assert tg["capabilities"]["text_limit"] == 4000


async def test_stranger_dm_gets_pairing_code_group_stranger_dropped(env: Env) -> None:
    await env.inbound("hi", sender="99", chat="99", thread="", direct=True)
    assert "配對" in env.tg.texts()[-1]
    code = env.store.list_pairing("telegram")[0].code
    assert f"{code[:4]}-{code[4:]}" in env.tg.texts()[-1]
    assert ("channels.pairing_request", {"platform": "telegram", "code": code, "sender_name": "alice"}) in env.fake.events
    sent_before = len(env.tg.sent)
    await env.inbound("hi from group", sender="98")
    assert len(env.tg.sent) == sent_before and env.fake.delivered == []
    assert len(env.store.list_pairing("telegram")) == 1
    # Approval lets the sender through and notifies them.
    assert (await env.m.pairing_approve("telegram", code))["ok"]
    assert env.tg.sent[-1][1].startswith("✅")
    env.store.bind("pane-dm", Location("telegram", "default", "99", ""))
    await env.inbound("now allowed", sender="99", chat="99", thread="", direct=True)
    assert env.fake.delivered[-1] == ("pane-dm", "now allowed", "telegram:alice")


async def test_dedup_by_message_id(env: Env) -> None:
    await env.inbound("once", mid="same")
    await env.inbound("once", mid="same")
    assert len(env.fake.delivered) == 1


@pytest.mark.parametrize("word", ["stop", "停止", "/stop", "ESC", "/stop@navide_bot"])
async def test_stop_words_interrupt_instead_of_delivering(env: Env, word: str) -> None:
    await env.inbound(word)
    assert env.fake.interrupts == ["pane-1"] and env.fake.delivered == []
    assert env.tg.texts()[-1] == MSG_INTERRUPTED


async def test_binding_routing_and_unbound_topic(env: Env) -> None:
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "web"))
    await env.inbound("to one", thread="50")
    await env.inbound("to two", thread="51")
    assert [d[0] for d in env.fake.delivered] == ["pane-1", "pane-2"]
    await env.inbound("nowhere", thread="52")
    assert env.tg.texts()[-1] == MSG_NOT_BOUND and len(env.fake.delivered) == 2


async def test_alias_follows_rebuilt_pane(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1b"
    await env.inbound("hello")
    assert env.fake.delivered[-1][0] == "pane-1b"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1b"]


async def test_outbound_after_turn_complete_only(env: Env) -> None:
    env.turn_complete("pane-1", "stale turn before anything was sent")
    await env.inbound("do it")
    # Still queued: a turn ending now is the one the message is waiting behind.
    env.turn_complete("pane-1", "not the reply")
    await asyncio.sleep(0.05)
    assert "not the reply" not in env.tg.texts()
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", "the **answer**")
    await _until(lambda: "the **answer**" in env.tg.texts())
    loc = next(loc for loc, t in env.tg.sent if t == "the **answer**")
    assert (loc.chat_id, loc.thread_id) == ("-100", "50")
    assert any(text.startswith("✅") for _, text in env.tg.edits)
    assert env.tg.typing >= 1
    # A later turn with no new message is not relayed.
    env.turn_complete("pane-1", "unsolicited")
    await asyncio.sleep(0.05)
    assert "unsolicited" not in env.tg.texts()


async def test_long_reply_is_chunked(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.turn_complete("pane-1", "\n".join("x" * 99 for _ in range(100)))
    await _until(lambda: sum(1 for t in env.tg.texts() if t.startswith("xxx")) == 3)


async def test_busy_pane_gets_received_status_message(env: Env) -> None:
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    await env.inbound("queued please")
    assert env.tg.texts()[-1] == MSG_RECEIVED_BUSY
    status_id = str(len(env.tg.sent))
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: any(mid == status_id and t == MSG_WORKING for mid, t in env.tg.edits))
    assert env.tg.texts().count(MSG_WORKING) == 0  # edited in place, not re-sent


async def test_status_edits_stop_after_three_failures(env: Env) -> None:
    await env.inbound("go")
    env.tg.fail_edits = True
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.4)
    assert len(env.tg.edits) == 3


async def test_delivery_failure_posts_notice(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "failed", "reason": "pane-closed"}
    await _until(lambda: any("pane-closed" in t for t in env.tg.texts()))


async def test_held_gone_posts_notice(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "HOLD_FAILURE_AFTER_S", 0.0)
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "queued", "hold": {"key": "gone"}}
    await _until(lambda: any("gone" in t for t in env.tg.texts()))
    await asyncio.sleep(0.05)
    assert sum("gone" in t for t in env.tg.texts()) == 1


async def test_awaiting_posts_relay_prompt_once(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}
    env.fake.kind = "question"
    await _until(lambda: any(t.startswith("⏸ pane 需要確認（question）") for t in env.tg.texts()))
    await asyncio.sleep(0.1)
    assert sum(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()) == 1


async def test_kill_switch_stops_everything(env: Env) -> None:
    await env.m.set_global_enabled(False)
    assert env.tg.status.lifecycle == "stopped"
    assert env.m.list()["enabled"] is False
    await env.inbound("ignored")
    assert env.fake.delivered == []
    await env.m.set_global_enabled(True)
    assert env.adapters["telegram"].status.lifecycle == "ready"


async def test_same_token_is_refused_on_second_platform(env: Env) -> None:
    result = await env.m.configure("discord", {}, {"token": "tok-A"})
    assert not result["ok"] and "telegram" in result["error"]
    assert "channel-discord" not in env.fake.secrets
    assert (await env.m.configure("discord", {}, {"token": "tok-B"}))["ok"]


async def test_pane_unregister_keeps_binding(env: Env) -> None:
    # Unregister also means rebuild / detach / workspace switch: never unbind here.
    env.m.on_pane_activity("pane-1", None)
    await asyncio.sleep(0.05)
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]


async def test_bind_new_creates_topic_and_status_broadcast(env: Env) -> None:
    result = await env.m.bind("pane-9", "api-refactor", "telegram", "new", "-100")
    assert result["ok"] and result["binding"]["thread_id"] == "77"
    assert result["binding"]["title"] == "api-refactor"
    await _until(lambda: any(e == "channels.status" and p["platform"] == "telegram" for e, p in env.fake.events))


async def test_remove_platform_clears_secret_and_bindings(env: Env) -> None:
    await env.m.remove("telegram")
    assert env.fake.secrets["channel-telegram"] is None
    assert env.store.bindings() == [] and env.store.list_allow(None) == []
    assert env.tg.status.lifecycle == "stopped"


async def test_queue_cap_per_pane(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "MAX_QUEUED_PER_PANE", 2)
    for i in range(3):
        await env.inbound(f"m{i}")
    assert len(env.fake.delivered) == 2 and "排隊" in env.tg.texts()[-1]


async def test_second_message_queued_behind_first_turn_still_gets_its_reply(env: Env) -> None:
    await env.inbound("first")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    await env.inbound("second")  # sits in the pane's queue behind turn 1
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "reply one")
    await _until(lambda: "reply one" in env.tg.texts())
    env.fake.verdicts["k2"] = {"status": "delivered"}  # now injected
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "reply two")
    await _until(lambda: "reply two" in env.tg.texts())


async def test_second_message_not_rearmed_after_unbind(env: Env) -> None:
    await env.inbound("first")
    await env.m.unbind("pane-1")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await asyncio.sleep(0.05)
    env.turn_complete("pane-1", "orphan reply")
    await asyncio.sleep(0.05)
    assert "orphan reply" not in env.tg.texts()


async def test_unbind_tells_the_chat_it_was_disconnected(env: Env) -> None:
    await env.m.unbind("pane-1", pane_name="api-refactor")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    assert "🔌 這個聊天室已和 pane「api-refactor」中斷連接，之後的訊息不會再送進 pane。" in env.tg.texts()
    assert env.store.bindings() == []


async def test_bind_tells_the_chat_which_pane_it_drives(env: Env) -> None:
    await env.m.unbind("pane-1")
    res = await env.m.bind("pane-2", "api-refactor", "telegram", "existing", "-100", "50")
    assert res["ok"] is True
    await _until(lambda: any(t.startswith("🔗") for t in env.tg.texts()))
    assert "🔗 已連接 pane「api-refactor」，在這裡傳的訊息會送進這個 pane；傳 stop 可以中斷。" in env.tg.texts()


async def test_unbind_on_close_says_the_pane_closed(env: Env) -> None:
    await env.m.unbind("pane-1", reason="closed", pane_name="api-refactor")
    await _until(lambda: any(t.startswith("🔌") for t in env.tg.texts()))
    assert "🔌 pane「api-refactor」已關閉，這個聊天室已中斷連接。" in env.tg.texts()


async def test_unbind_of_an_unbound_pane_posts_nothing(env: Env) -> None:
    await env.m.unbind("no-such-pane")
    await asyncio.sleep(0.05)
    assert not any(t.startswith("🔌") for t in env.tg.texts())


async def test_seen_chats_survive_a_restart(env: Env, tmp_path) -> None:
    await env.inbound("hi", chat="-200", thread="")
    assert [c["chat_id"] for c in env.m.locations("telegram")["locations"]] == ["-200"]
    # A fresh manager over the same database (a backend restart) still lists it.
    again = ChannelManager(ChannelStore(env.db), env.fake.seams(), factory_for=lambda _p: None)
    assert [c["chat_id"] for c in again.locations("telegram")["locations"]] == ["-200"]


async def test_a_newly_seen_chat_announces_a_change_once(env: Env) -> None:
    env.fake.events.clear()
    await env.inbound("hi", chat="-300", thread="")
    await env.inbound("again", chat="-300", thread="")
    assert [e for e, _ in env.fake.events].count("channels.changed") == 1


async def test_approved_pairing_lists_the_dm_without_another_message(env: Env) -> None:
    await env.inbound("hello", sender="99", chat="99", thread="", direct=True)
    code = env.store.list_pairing("telegram")[0].code
    await env.m.pairing_approve("telegram", code)
    locs = env.m.locations("telegram")["locations"]
    assert {"chat_id": "99", "kind": "direct"}.items() <= next(c for c in locs if c["chat_id"] == "99").items()


async def test_a_chat_held_by_another_pane_is_refused_until_released(env: Env) -> None:
    # pane-1 holds telegram -100 / thread 50 (fixture); pane-2 must not take it silently.
    res = await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50")
    assert res["ok"] is False and res["holder_pane_id"] == "pane-1"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]
    await env.m.unbind("pane-1")
    res = await env.m.bind("pane-2", "b", "telegram", "existing", "-100", "50")
    assert res["ok"] is True
    assert [b.pane_id for b in env.store.bindings()] == ["pane-2"]


async def test_running_watch_is_capped_but_late_reply_still_sent(clocked) -> None:
    env, clock = clocked
    await env.inbound("long job")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    pending = env.m._pending["pane-1"]
    clock.t += mgr_mod.RUN_WATCH_MAX_S + 1
    await _until(lambda: pending.task.done())
    assert env.tg.edits[-1][1] == mgr_mod.MSG_STILL_RUNNING
    typing, edits = env.tg.typing, len(env.tg.edits)
    clock.t += 60
    await asyncio.sleep(0.1)
    assert (env.tg.typing, len(env.tg.edits)) == (typing, edits)  # indicators stopped
    env.turn_complete("pane-1", "finally")
    await _until(lambda: "finally" in env.tg.texts())


async def test_pane_close_drops_pending_and_its_task(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    task = env.m._pending["pane-1"].task
    env.m.on_pane_activity("pane-1", None)
    assert "pane-1" not in env.m._pending
    await _until(lambda: task.done())
    assert task.cancelled()
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1"]


# --- round 2 -------------------------------------------------------------------


async def test_offline_pane_gets_notice_and_keeps_binding(env: Env) -> None:
    env.fake.gone.add("pane-1")
    await env.inbound("hello?")
    assert env.tg.texts()[-1] == mgr_mod.MSG_OFFLINE
    assert env.fake.delivered == [] and len(env.store.bindings()) == 1
    env.fake.gone.clear()
    await env.inbound("back")
    assert env.fake.delivered[-1][0] == "pane-1"


async def test_rebind_moves_binding_and_running_watch(env: Env) -> None:
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    result = await env.m.rebind("pane-1", "pane-1n")
    assert result["ok"] and result["binding"]["pane_id"] == "pane-1n"
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1n"]
    env.turn_complete("pane-1n", "reply after rebuild")
    await _until(lambda: "reply after rebuild" in env.tg.texts())
    assert await env.m.rebind("nobody", "x") == {"ok": True}


async def test_bind_refuses_unknown_pane_but_accepts_placeholder(env: Env) -> None:
    env.fake.gone.add("ghost")
    assert await env.m.bind("ghost", "g", "telegram", "existing", "-100", "60") == {
        "ok": False, "error": "pane not found"}
    # A restore placeholder is registered, so it resolves (the fake knows every non-gone id).
    result = await env.m.bind("placeholder-1", "p", "telegram", "existing", "-100", "61")
    assert result["ok"] and result["binding"]["pane_id"] == "placeholder-1"


async def test_debounce_joins_quick_lines_but_not_stop_words(env: Env, monkeypatch) -> None:
    monkeypatch.setattr(mgr_mod, "DEBOUNCE_S", 0.3)
    await env.inbound("line one", wait=False)
    await env.inbound("line two", wait=False)
    await env.inbound("stop", wait=False)  # bypasses the buffer
    await _until(lambda: env.fake.interrupts == ["pane-1"])
    assert env.fake.delivered == []
    await env.m.wait_idle()
    assert env.fake.delivered == [("pane-1", "line one\nline two", "telegram:alice")]
    # Another sender / later message is its own delivery.
    env.store.add_allow("telegram", "8", "bob", 1)
    await env.inbound("from bob", sender="8")
    await env.inbound("later")
    await _until(lambda: len(env.fake.delivered) == 3)
    assert [d[1] for d in env.fake.delivered[1:]] == ["from bob", "later"]


async def _awaiting(env: Env, *, stale_off_config: bool = False) -> None:
    # The relay is always on; a stale ``permission_relay: false`` must not turn it off.
    if stale_off_config:
        env.store.upsert_account("telegram", {"permission_relay": False})
    await env.inbound("go")
    env.fake.verdicts["k1"] = {"status": "delivered"}
    await _until(lambda: MSG_WORKING in env.tg.texts())
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "awaiting"}


def _relay_id(env: Env) -> str:
    return next(iter(env.m.relay._by_id))


async def test_stale_relay_off_config_is_ignored(env: Env) -> None:
    await _awaiting(env, stale_off_config=True)
    await _until(lambda: any(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()))
    assert env.m.relay._by_id != {}
    assert "⏸ pane 等待確認（permission）" not in env.tg.texts()


async def test_relay_on_prompt_buttons_and_yes(env: Env) -> None:
    import re

    await _awaiting(env)
    await _until(lambda: any(t.startswith("⏸ pane 需要確認") for t in env.tg.texts()))
    rid = _relay_id(env)
    assert re.fullmatch(r"[a-km-z]{5}", rid)
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "Allow Bash(npm run build)?" in text and f"yes {rid} / no {rid}" in text
    delivered_before = len(env.fake.delivered)
    await env.inbound(f"YES {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "allow"})]
    assert env.tg.texts()[-1] == "✅ 已送出：允許"
    assert len(env.fake.delivered) == delivered_before  # answered before the queue
    await env.inbound(f"no {rid}")  # single use
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED and len(env.fake.answers) == 1


async def test_relay_buttons_via_callback_and_question_option(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Keep", "Discard"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    assert sent_buttons[0] == [("1. Keep", f"nv1:{rid}:1"), ("2. Discard", f"nv1:{rid}:2")]
    assert all(len(data.encode()) <= 64 for _, data in sent_buttons[0])
    await env.m.handle_inbound(InboundMessage(
        platform="telegram", account="default", chat_id="-100", thread_id="50", sender_id="7",
        sender_name="alice", text="", message_id="cb:1", is_direct=False, ts=time.time(),
        callback_data=f"nv1:{rid}:2"))
    await env.m.wait_idle()
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]
    assert env.tg.texts()[-1] == "✅ 已送出：選項 2"


async def test_relay_rejects_stranger_and_reports_seam_error(env: Env) -> None:
    await _awaiting(env)
    await _until(lambda: env.m.relay._by_id)
    rid = _relay_id(env)
    await env.inbound(f"yes {rid}", sender="99")  # not allowlisted: dropped by the gate
    assert env.fake.answers == [] and rid in env.m.relay._by_id
    env.fake.answer_result = {"ok": False, "error": "unsupported for aider"}
    await env.inbound(f"y {rid}")
    assert env.tg.texts()[-1] == "⚠️ 送出失敗：unsupported for aider"


async def test_relay_id_expires_when_pane_leaves_awaiting_or_ttl(clocked, monkeypatch) -> None:
    env, clock = clocked
    await _awaiting(env)
    clock.t += 1  # the fake clock only moves when told: let the awaiting probe run
    await _until(lambda: env.m.relay._by_id)
    rid = _relay_id(env)
    env.fake.states["pane-1"] = {"exists": True, "busy": True, "display_status": "running"}
    clock.t += 1  # let the probe run again
    await _until(lambda: env.m.relay._by_id == {})
    await env.inbound(f"yes {rid}")
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED
    # TTL
    req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"))
    clock.t += 1801
    await env.inbound(f"yes {req.id}")
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_EXPIRED and env.fake.answers == []


# --- receive loop never waits on a slow chat ------------------------------------------


class _Gate:
    def __init__(self) -> None:
        self.release = asyncio.Event()

    async def block(self, *args, **kwargs):
        await self.release.wait()
        return {"ok": True, "sent": True, "msg_key": "kx", "pane_id": "pane-1"}


@pytest.mark.parametrize("stuck", ["interrupt", "deliver", "answer"])
async def test_stuck_seam_does_not_block_other_chats(env: Env, stuck: str) -> None:
    gate = _Gate()
    seen: list[str] = []  # texts that reached the deliver seam, stuck or not
    real_deliver = env.fake.deliver

    async def deliver(pane_id, text, from_display):
        seen.append(text)
        if stuck == "deliver":
            return await gate.block()
        return await real_deliver(pane_id, text, from_display)

    env.m._seams.deliver = deliver
    env.store.bind("pane-2", Location("telegram", "default", "-200", "", "other"))
    if stuck == "answer":
        env.store.upsert_account("telegram", {"permission_relay": True})
        req = env.m.relay.create("pane-1", "permission", [], Location("telegram", "default", "-100", "50"),
                                 prompt=env.fake.prompt)
        env.m._seams.answer = gate.block
        first = f"yes {req.id}"
    elif stuck == "interrupt":
        env.m._seams.interrupt = gate.block
        first = "stop"
    else:
        first = "slow"
    t0 = time.monotonic()
    await env.inbound(first, wait=False)  # returns at once: the receive loop stays free
    assert time.monotonic() - t0 < 0.2
    await env.inbound("side ping", chat="-200", thread="", wait=False)
    await _until(lambda: "side ping" in seen, timeout=1.0)
    gate.release.set()
    await env.m.wait_idle()


async def test_same_chat_keeps_order(env: Env) -> None:
    order: list[str] = []
    real = env.fake.deliver

    async def slow_first(pane_id, text, from_display):
        if text == "one":
            await asyncio.sleep(0.1)
        order.append(text)
        return await real(pane_id, text, from_display)

    env.m._seams.deliver = slow_first
    for text in ("one", "two", "three"):
        await env.inbound(text, wait=False)
    await env.m.wait_idle()
    assert order == ["one", "two", "three"]
    assert env.m._workers == {}  # retired once idle


async def test_stop_leaves_no_tasks(env: Env) -> None:
    gate = _Gate()
    env.m._seams.deliver = gate.block
    await env.inbound("hang", wait=False)
    await _until(lambda: env.m._workers)
    await env.m.stop()
    assert env.m._tasks == set() and env.m._workers == {}
    others = [t for t in asyncio.all_tasks() if t is not asyncio.current_task()
              and (t.get_coro().__qualname__.startswith("ChannelManager."))]
    assert all(t.done() for t in others)


# --- restart aliases and option-based relay kind ---------------------------------------


async def test_bindings_follow_alias_after_restart(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1-new"  # restored pane registered with formerPaneIds
    assert [b["pane_id"] for b in env.m.bindings()["bindings"]] == ["pane-1-new"]
    await _until(lambda: ("channels.changed", {}) in env.fake.events)
    listed = env.m.list()  # already in sync: no second change
    assert listed["enabled"] and [b.pane_id for b in env.store.bindings()] == ["pane-1-new"]


async def test_first_activity_from_new_id_syncs_bindings(env: Env) -> None:
    env.fake.aliases["pane-1"] = "pane-1-new"
    env.m.on_pane_activity("pane-1-new", {"event_type": "agent_active", "text": "",
                                          "ts_monotonic": time.monotonic()})
    assert [b.pane_id for b in env.store.bindings()] == ["pane-1-new"]


async def test_alias_sync_never_overwrites_an_existing_binding(env: Env) -> None:
    env.store.bind("pane-2", Location("telegram", "default", "-100", "51", "b"))
    env.fake.aliases["pane-1"] = "pane-2"
    env.m.bindings()
    assert sorted(b.pane_id for b in env.store.bindings()) == ["pane-1", "pane-2"]


async def test_options_not_starting_with_yes_relay_as_question(env: Env) -> None:
    env.fake.kind = "permission"  # what Claude's AskUserQuestion reports
    env.fake.options = ["Keep it", "Discard"]
    await _awaiting(env)
    await _until(lambda: env.m.relay._by_id)
    rid = _relay_id(env)
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "（question）" in text and "1. Keep it" in text and f"回覆 <選項編號> {rid}" in text
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "question", "option": 2})]


async def test_options_starting_with_yes_relay_as_permission(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Yes", "Yes, and don't ask again", "No"]
    await _awaiting(env)
    await _until(lambda: env.m.relay._by_id)
    rid = _relay_id(env)
    assert f"yes {rid} / no {rid}" in next(t for t in env.tg.texts() if t.startswith("⏸"))
    await env.inbound(f"no {rid}")
    assert env.fake.answers == [("pane-1", {"kind": "permission", "choice": "deny"})]


async def test_permanent_allow_option_is_neither_offered_nor_accepted(env: Env) -> None:
    env.fake.kind = "question"
    env.fake.options = ["Run it once", "Always allow Bash(rm:*)", "Cancel"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    # Offered options keep their on-screen numbers; the permanent one is left out.
    assert sent_buttons[0] == [("1. Run it once", f"nv1:{rid}:1"), ("3. Cancel", f"nv1:{rid}:3")]
    text = next(t for t in env.tg.texts() if t.startswith("⏸"))
    assert "2. Always allow" not in text and "3. Cancel" in text
    await env.inbound(f"2 {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_PERMANENT


async def test_yes_refused_when_option_one_is_permanent_allow(env: Env) -> None:
    env.fake.options = ["Yes, and don't ask again this session", "No"]
    sent_buttons: list = []
    orig = env.tg.send_text

    async def capture(loc, text, *, buttons=None):
        if buttons:
            sent_buttons.append(buttons)
        return await orig(loc, text, buttons=buttons)

    env.tg.send_text = capture
    await _awaiting(env)
    await _until(lambda: sent_buttons)
    rid = _relay_id(env)
    assert sent_buttons[0] == [("拒絕", f"nv1:{rid}:n")]
    await env.inbound(f"yes {rid}")
    assert env.fake.answers == []
    assert env.tg.texts()[-1] == mgr_mod.MSG_RELAY_PERMANENT
