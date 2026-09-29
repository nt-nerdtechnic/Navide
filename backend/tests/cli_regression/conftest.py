from pathlib import Path

import pytest

from .support.backend_process import BackendProcess


@pytest.fixture
async def backend_process(tmp_path: Path):
    async with BackendProcess(tmp_path / "backend") as backend:
        yield backend
