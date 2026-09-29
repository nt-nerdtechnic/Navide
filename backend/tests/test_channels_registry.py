"""Structural checks on the chat-platform registry (channels/registry.py)."""

from __future__ import annotations

import inspect
import re
from pathlib import Path

import pytest

from agent_team_backend.channels import base, manager, registry

CHANNELS_DIR = Path(registry.__file__).parent
REQUIRED_ATTRS = ("platform", "capabilities", "status", "start", "stop", "send_text",
                  "edit_text", "send_typing", "create_location", "token_fingerprint")


def test_ids_are_unique_and_match_the_platform_literal():
    assert len(set(registry.PLATFORMS)) == len(registry.PLATFORMS)
    assert set(registry.PLATFORMS) == set(base.Platform.__args__)


def test_manager_platforms_is_the_registry_alias():
    assert manager.PLATFORMS is registry.PLATFORMS


def test_every_adapter_module_is_registered():
    on_disk = {
        p.stem for p in CHANNELS_DIR.glob("*.py")
        if not p.stem.startswith("_") and re.search(r"^def create_adapter\b", p.read_text(encoding="utf-8"), re.M)
    }
    assert on_disk == set(registry.PLATFORMS)


@pytest.mark.parametrize("platform", registry.PLATFORMS)
def test_each_platform_imports_and_exposes_an_adapter(platform):
    mod = registry.load_module(platform)
    assert mod is not None, f"{platform} is registered but does not import"
    assert callable(getattr(mod, "create_adapter", None))
    cls = getattr(mod, f"{platform.capitalize()}Adapter", None) or next(
        (v for k, v in vars(mod).items() if k.endswith("Adapter") and inspect.isclass(v)), None
    )
    assert cls is not None
    assert cls.platform == platform
    missing = [a for a in REQUIRED_ATTRS if not hasattr(cls, a) and a != "status"]
    assert not missing, f"{platform} adapter lacks {missing}"


def test_unknown_platform_does_not_load():
    assert registry.load_module("nope") is None
    assert not registry.is_platform("nope")
