"""Blob segments (sync_keyring) and the blob transfer client (skill_blobs).

The object store is faked in-process with a real HTTP server on 127.0.0.1, so
the presigned-URL path, Content-Length streaming and Range resumption run for
real; the ``blobs.*`` verbs are faked by a small in-memory server that keeps the
same rules as Navide-Server (part sizes checked on commit, dedup on begin).
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import threading
import tracemalloc
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import skill_blobs, sync_keyring
from agent_team_backend.db import Database
from agent_team_backend.skill_blobs import BlobRef, Layout

SMALL = Layout(segment_bytes=1024, segments_per_part=4)
REAL = Layout(segment_bytes=1024 * 1024, segments_per_part=8)


@pytest.fixture
def key() -> str:
    sync_keyring.ensure_account_key()
    yield sync_keyring.active_key_id()
    sync_keyring.forget_account_key()


def _write(path: Path, size: int) -> Path:
    path.write_bytes(os.urandom(size))
    return path


# ── fake object store + fake Navide server ─────────────────────────────


class FakeStore:
    """Object storage over HTTP plus the blobs.* verbs, both in one process."""

    def __init__(self, root: Path, layout: Layout) -> None:
        self.root = root
        self.layout = layout
        self.blobs: dict[str, dict[str, Any]] = {}
        self.puts: list[tuple[str, int]] = []
        self.gets: list[dict[str, str]] = []
        self.fail_put: set[tuple[str, int]] = set()
        self.cut_get_after: int | None = None
        store = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def do_PUT(self) -> None:  # noqa: N802 - http.server naming
                _, _, blob_id, n = self.path.split("/")
                length = int(self.headers["Content-Length"])
                target = store.root / f"{blob_id}.{n}"
                with open(target, "wb") as out:
                    left = length
                    while left:
                        chunk = self.rfile.read(min(65536, left))
                        if not chunk:
                            break
                        out.write(chunk)
                        left -= len(chunk)
                if (blob_id, int(n)) in store.fail_put:
                    store.fail_put.discard((blob_id, int(n)))
                    target.unlink()
                    self.send_response(500)
                    self.end_headers()
                    return
                store.puts.append((blob_id, int(n)))
                self.send_response(200)
                self.send_header("ETag", '"etag"')
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self) -> None:  # noqa: N802
                blob_id = self.path.split("/")[2]
                store.gets.append(dict(self.headers))
                obj = store.root / f"{blob_id}.obj"
                size = obj.stat().st_size
                start = 0
                rng = self.headers.get("Range")
                if rng:
                    start = int(rng.split("=")[1].rstrip("-"))
                    self.send_response(206)
                else:
                    self.send_response(200)
                self.send_header("Content-Length", str(size - start))
                self.end_headers()
                cut = store.cut_get_after
                store.cut_get_after = None
                with open(obj, "rb") as fh:
                    fh.seek(start)
                    sent = 0
                    while chunk := fh.read(65536):
                        if cut is not None and sent + len(chunk) > cut:
                            self.wfile.write(chunk[: cut - sent])
                            self.close_connection = True
                            return
                        self.wfile.write(chunk)
                        sent += len(chunk)

        self.http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base = f"http://127.0.0.1:{self.http.server_address[1]}"
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.http.shutdown()

    def _part_size(self, size: int, n: int, count: int) -> int:
        part = self.layout.part_bytes
        return part if n < count else size - (count - 1) * part

    async def request(self, kind: str, p: dict[str, Any]) -> dict[str, Any]:
        def ok(payload: dict[str, Any]) -> dict[str, Any]:
            return {"ok": True, "payload": payload}

        def err(code: str, details: Any = None) -> dict[str, Any]:
            return {"ok": False, "error": {"code": code, "message": code, "details": details}}

        if kind == "blobs.caps":
            return ok({"version": 2, "segmentBytes": self.layout.segment_bytes,
                       "segmentsPerPart": self.layout.segments_per_part, "partBytes": self.layout.part_bytes})
        if kind == "blobs.stat":
            return ok({"blobs": [{"blobId": b, "state": self.blobs[b]["state"]} if b in self.blobs
                                 else {"blobId": b, "state": "absent"} for b in p["blobIds"]]})
        blob = self.blobs.get(p.get("blobId", ""))
        if kind == "blobs.begin":
            size = p["sizeBytes"]
            count = max(1, -(-size // self.layout.part_bytes))
            if blob and blob["state"] == "complete":
                return ok({"state": "complete"})
            if not blob:
                blob = self.blobs[p["blobId"]] = {"state": "partial", "size": size, "count": count}
            parts = [{"partNumber": n, "size": (self.root / f"{p['blobId']}.{n}").stat().st_size}
                     for n in range(1, count + 1) if (self.root / f"{p['blobId']}.{n}").exists()]
            return ok({"state": "partial", "partCount": count, "parts": parts})
        if kind == "blobs.presignPut":
            return ok({"urls": [{"partNumber": n, "url": f"{self.base}/up/{p['blobId']}/{n}"} for n in p["partNumbers"]]})
        if kind == "blobs.commit":
            missing = [n for n in range(1, blob["count"] + 1)
                       if not (self.root / f"{p['blobId']}.{n}").exists()
                       or (self.root / f"{p['blobId']}.{n}").stat().st_size != self._part_size(blob["size"], n, blob["count"])]
            if missing:
                for n in missing:
                    (self.root / f"{p['blobId']}.{n}").unlink(missing_ok=True)
                return err("INCOMPLETE", {"missing": missing})
            with open(self.root / f"{p['blobId']}.obj", "wb") as out:
                for n in range(1, blob["count"] + 1):
                    part = self.root / f"{p['blobId']}.{n}"
                    with open(part, "rb") as fh:
                        while chunk := fh.read(65536):
                            out.write(chunk)
                    part.unlink()
            blob["state"] = "complete"
            return ok({"state": "complete"})
        if kind == "blobs.presignGet":
            if not blob or blob["state"] != "complete":
                return err("NOT_FOUND")
            return ok({"url": f"{self.base}/obj/{p['blobId']}", "sizeBytes": blob["size"]})
        return err("UNKNOWN_TYPE")


@pytest.fixture
def store(tmp_path: Path):
    root = tmp_path / "s3"
    root.mkdir()
    s = FakeStore(root, SMALL)
    yield s
    s.close()


def _run(coro):
    return asyncio.run(coro)


# ── sync_keyring: segments and names ──────────────────────────────────


def test_a_segment_round_trips_and_is_bound_to_its_place(key) -> None:
    bid = "a" * 64
    sealed = sync_keyring.seal_segment(b"hello", kid=key, blob_id=bid, index=2, count=5)
    assert len(sealed) == 5 + sync_keyring.BLOB_SEGMENT_OVERHEAD
    assert sync_keyring.open_segment(sealed, kid=key, blob_id=bid, index=2, count=5) == b"hello"
    for moved in ({"index": 3, "count": 5, "blob_id": bid}, {"index": 2, "count": 4, "blob_id": bid},
                  {"index": 2, "count": 5, "blob_id": "b" * 64}):
        with pytest.raises(sync_keyring.KeyringError):
            sync_keyring.open_segment(sealed, kid=key, **moved)
    flipped = bytearray(sealed)
    flipped[20] ^= 1
    with pytest.raises(sync_keyring.KeyringError):
        sync_keyring.open_segment(bytes(flipped), kid=key, blob_id=bid, index=2, count=5)


def test_a_segment_under_a_key_this_machine_lacks_says_so(key) -> None:
    with pytest.raises(sync_keyring.UnknownKeyId):
        sync_keyring.open_segment(b"\x00" * 40, kid="00" * 8, blob_id="a" * 64, index=0, count=1)


def test_a_blob_name_is_keyed_stable_and_changes_with_the_key(key, tmp_path: Path) -> None:
    f = _write(tmp_path / "f.bin", 5000)
    first = skill_blobs.hash_file(f)
    assert first == skill_blobs.hash_file(f)
    assert first.kid == key and first.size == 5000
    # Not a plain content hash: the server cannot compare it across accounts.
    assert first.blob_id != hashlib.sha256(f.read_bytes()).hexdigest()
    sync_keyring.rotate_account_key()
    rotated = skill_blobs.hash_file(f)
    assert rotated.blob_id != first.blob_id
    # The old name is still derivable under the old key, which the ring keeps.
    assert skill_blobs.hash_file(f, kid=key) == first


# ── layout ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("size", [0, 1, 1023, 1024, 1025, 4096, 4097, 4096 * 3 + 5])
def test_parts_add_up_to_the_sealed_object(size: int) -> None:
    parts = [SMALL.part_sealed_size(n, size) for n in range(1, SMALL.part_count(size) + 1)]
    assert sum(parts) == SMALL.sealed_size(size)
    # Every part but the last is exactly the fixed part size — what S3 multipart
    # and the server's commit check both require.
    assert all(p == SMALL.part_bytes for p in parts[:-1])
    assert 0 < parts[-1] <= SMALL.part_bytes


def test_the_real_layout_keeps_parts_above_the_s3_minimum() -> None:
    assert REAL.part_bytes > 5 * 1024 * 1024
    assert REAL.part_bytes == 8 * (1024 * 1024 + 28)


# ── upload / download ─────────────────────────────────────────────────


@pytest.mark.parametrize("size", [0, 1, 1024, 4096, 4096 * 2 + 777])
def test_a_file_goes_up_and_comes_back_byte_for_byte(key, store, tmp_path: Path, size: int) -> None:
    src = _write(tmp_path / "src.bin", size)
    ref = skill_blobs.hash_file(src)
    seen: list[tuple[int, int]] = []
    _run(skill_blobs.upload(store.request, src, ref, SMALL, progress=lambda d, t: seen.append((d, t))))
    assert seen[-1] == (SMALL.sealed_size(size), SMALL.sealed_size(size))
    dest = tmp_path / "out" / "dest.bin"
    _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert dest.read_bytes() == src.read_bytes()
    assert not dest.with_name("dest.bin.part").exists()


def test_the_same_file_is_uploaded_once(key, store, tmp_path: Path) -> None:
    src = _write(tmp_path / "src.bin", 9000)
    ref = skill_blobs.hash_file(src)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    puts = len(store.puts)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    assert len(store.puts) == puts


def test_an_interrupted_upload_resumes_with_only_the_missing_parts(key, store, tmp_path: Path) -> None:
    src = _write(tmp_path / "src.bin", 4096 * 3 + 10)  # four parts
    ref = skill_blobs.hash_file(src)
    store.fail_put.add((ref.blob_id, 3))
    with pytest.raises(skill_blobs.BlobError):
        _run(skill_blobs.upload(store.request, src, ref, SMALL))
    assert [n for _, n in store.puts] == [1, 2]
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    assert [n for _, n in store.puts] == [1, 2, 3, 4]
    dest = tmp_path / "dest.bin"
    _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert dest.read_bytes() == src.read_bytes()


def test_a_file_that_changes_mid_upload_is_not_committed(key, store, tmp_path: Path, monkeypatch) -> None:
    src = _write(tmp_path / "src.bin", 4096 * 2 + 1)
    ref = skill_blobs.hash_file(src)
    real = skill_blobs._put_part

    def touch_then_put(*args: Any) -> int:
        sent = real(*args)
        os.utime(src, ns=(1, 1))
        return sent

    monkeypatch.setattr(skill_blobs, "_put_part", touch_then_put)
    with pytest.raises(skill_blobs.BlobChanged):
        _run(skill_blobs.upload(store.request, src, ref, SMALL))
    assert store.blobs[ref.blob_id]["state"] == "partial"


def test_a_broken_download_resumes_with_a_range_request(key, store, tmp_path: Path) -> None:
    src = _write(tmp_path / "src.bin", 1024 * 10 + 3)
    ref = skill_blobs.hash_file(src)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    store.cut_get_after = SMALL.sealed_segment * 4 + 100
    dest = tmp_path / "dest.bin"
    _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert dest.read_bytes() == src.read_bytes()
    assert len(store.gets) == 2
    assert store.gets[1].get("Range") == f"bytes={SMALL.sealed_segment * 4}-"


def _stored_object(store: FakeStore, ref: BlobRef) -> Path:
    return store.root / f"{ref.blob_id}.obj"


def test_a_tampered_object_never_reaches_its_destination(key, store, tmp_path: Path) -> None:
    src = _write(tmp_path / "src.bin", 3000)
    ref = skill_blobs.hash_file(src)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    obj = _stored_object(store, ref)
    raw = bytearray(obj.read_bytes())
    raw[len(raw) // 2] ^= 1
    obj.write_bytes(bytes(raw))
    dest = tmp_path / "dest.bin"
    with pytest.raises(skill_blobs.BlobIntegrityError):
        _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert not dest.exists()


def test_a_truncated_object_is_refused(key, store, tmp_path: Path) -> None:
    src = _write(tmp_path / "src.bin", 3000)
    ref = skill_blobs.hash_file(src)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    obj = _stored_object(store, ref)
    # Drop the last whole segment: every remaining segment still opens on its
    # own, so the end of the stream is what must be noticed.
    obj.write_bytes(obj.read_bytes()[: SMALL.sealed_segment * 2])
    dest = tmp_path / "dest.bin"
    with pytest.raises(skill_blobs.BlobError):
        _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert not dest.exists()
    # And a server that owns up to the shorter size is refused before any byte moves.
    store.blobs[ref.blob_id]["size"] = SMALL.sealed_segment * 2
    with pytest.raises(skill_blobs.BlobIntegrityError):
        _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert not dest.exists()


def test_another_files_object_under_this_name_is_refused(key, store, tmp_path: Path) -> None:
    a = _write(tmp_path / "a.bin", 3000)
    b = _write(tmp_path / "b.bin", 3000)
    ra, rb = skill_blobs.hash_file(a), skill_blobs.hash_file(b)
    _run(skill_blobs.upload(store.request, a, ra, SMALL))
    _run(skill_blobs.upload(store.request, b, rb, SMALL))
    _stored_object(store, ra).write_bytes(_stored_object(store, rb).read_bytes())
    dest = tmp_path / "dest.bin"
    with pytest.raises(skill_blobs.BlobIntegrityError):
        _run(skill_blobs.download(store.request, ra, dest, SMALL))
    assert not dest.exists()


def test_large_files_stream_in_bounded_memory(key, tmp_path: Path) -> None:
    root = tmp_path / "s3"
    root.mkdir()
    store = FakeStore(root, REAL)
    try:
        size = 24 * 1024 * 1024 + 12345
        src = tmp_path / "big.bin"
        with open(src, "wb") as fh:
            for _ in range(24):
                fh.write(os.urandom(1024 * 1024))
            fh.write(os.urandom(12345))
        ref = skill_blobs.hash_file(src)
        dest = tmp_path / "big.out"
        tracemalloc.start()
        try:
            _run(skill_blobs.upload(store.request, src, ref, REAL))
            _run(skill_blobs.download(store.request, ref, dest, REAL))
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        assert dest.stat().st_size == size
        assert skill_blobs.hash_file(dest) == ref
        # A few segments' worth, never the file: 24 MiB would not fit under this.
        assert peak < 8 * 1024 * 1024, peak
    finally:
        store.close()


# ── capability negotiation ────────────────────────────────────────────


@pytest.mark.parametrize("code", ["UNKNOWN_TYPE", "UNSUPPORTED"])
def test_a_server_without_blobs_means_no_layout(code: str) -> None:
    async def request(kind: str, p: dict[str, Any]) -> dict[str, Any]:
        return {"ok": False, "error": {"code": code, "message": "no"}}

    assert _run(skill_blobs.server_layout(request)) is None


def test_the_layout_comes_from_the_server(store) -> None:
    assert _run(skill_blobs.server_layout(store.request)) == SMALL


# ── digest cache ──────────────────────────────────────────────────────


def test_the_digest_cache_rehashes_only_what_changed(key, tmp_path: Path, monkeypatch) -> None:
    db = Database(tmp_path / "navide.db")
    cache = skill_blobs.DigestCache(db)
    f = _write(tmp_path / "f.bin", 2000)
    calls: list[Path] = []
    real = skill_blobs.hash_file
    monkeypatch.setattr(skill_blobs, "hash_file", lambda p, kid=None: calls.append(p) or real(p, kid))
    first = cache.ref_for(f)
    assert cache.ref_for(f) == first and len(calls) == 1
    _write(f, 2001)
    assert cache.ref_for(f) != first and len(calls) == 2
    sync_keyring.rotate_account_key()
    assert cache.ref_for(f).kid == sync_keyring.active_key_id() and len(calls) == 3
    db.close()


def test_a_connection_reset_mid_download_is_resumed(key, store, tmp_path: Path, monkeypatch) -> None:
    src = _write(tmp_path / "src.bin", 1024 * 10 + 3)
    ref = skill_blobs.hash_file(src)
    _run(skill_blobs.upload(store.request, src, ref, SMALL))
    real = skill_blobs.urlopen
    state = {"first": True}

    class Resets:
        def __init__(self, res: Any) -> None:
            self.res, self.status, self.left = res, res.status, SMALL.sealed_segment * 3

        def read(self, n: int = -1) -> bytes:
            if self.left <= 0:
                raise ConnectionResetError("reset by peer")
            chunk = self.res.read(min(n, self.left))
            self.left -= len(chunk)
            return chunk

        def __enter__(self) -> Resets:
            return self

        def __exit__(self, *exc: Any) -> None:
            self.res.close()

    def urlopen(req: Any, timeout: Any = None) -> Any:
        res = real(req, timeout=timeout)
        if state["first"]:
            state["first"] = False
            return Resets(res)
        return res

    monkeypatch.setattr(skill_blobs, "urlopen", urlopen)
    dest = tmp_path / "dest.bin"
    _run(skill_blobs.download(store.request, ref, dest, SMALL))
    assert dest.read_bytes() == src.read_bytes()
    assert store.gets[-1].get("Range") == f"bytes={SMALL.sealed_segment * 3}-"
