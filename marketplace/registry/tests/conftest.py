from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from registry.app import create_app
from registry.config import Settings


@pytest.fixture()
def settings(tmp_path) -> Settings:
    return Settings(data_dir=tmp_path)


@pytest.fixture()
def client(settings: Settings) -> TestClient:
    # No context manager: this app has no lifespan startup to run.
    return TestClient(create_app(settings))
