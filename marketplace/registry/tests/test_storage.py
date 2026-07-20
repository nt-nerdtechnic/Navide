from __future__ import annotations

import pytest

from registry.storage import LocalStorageBackend, StorageError


def test_put_get_roundtrip(tmp_path) -> None:
    store = LocalStorageBackend(tmp_path)
    store.put("a/b/c.bin", b"payload")
    assert store.exists("a/b/c.bin")
    assert store.get("a/b/c.bin") == b"payload"


def test_open_stream(tmp_path) -> None:
    store = LocalStorageBackend(tmp_path)
    store.put("k", b"streamed")
    with store.open_stream("k") as fh:
        assert fh.read() == b"streamed"


def test_get_missing_raises(tmp_path) -> None:
    store = LocalStorageBackend(tmp_path)
    with pytest.raises(StorageError):
        store.get("nope")


def test_delete(tmp_path) -> None:
    store = LocalStorageBackend(tmp_path)
    store.put("k", b"x")
    store.delete("k")
    assert not store.exists("k")


def test_traversal_rejected(tmp_path) -> None:
    store = LocalStorageBackend(tmp_path)
    with pytest.raises(StorageError):
        store.put("../escape", b"x")
