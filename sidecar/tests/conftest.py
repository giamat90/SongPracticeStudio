import os
import sys
from pathlib import Path

import pytest

SIDECAR_DIR = Path(__file__).resolve().parent.parent
if str(SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(SIDECAR_DIR))


@pytest.fixture(autouse=True)
def isolated_home(tmp_path, monkeypatch):
    """version_check caches under ~/.songpracticestudio; keep every test away from the real home."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOME", str(home))
    return home


@pytest.fixture
def sidecar_dir() -> Path:
    return SIDECAR_DIR


@pytest.fixture
def python_exe() -> str:
    return sys.executable


def pytest_collection_modifyitems(config, items):
    if os.environ.get("SPS_SKIP_SLOW"):
        skip = pytest.mark.skip(reason="SPS_SKIP_SLOW is set")
        for item in items:
            if "slow" in item.keywords:
                item.add_marker(skip)
