"""The lyrics commands over the real stdio protocol (test-only `uniform` engine, no model)."""

import numpy as np
import pytest

from helpers import sine, write_wav
from test_protocol import Sidecar

pytestmark = pytest.mark.slow


@pytest.fixture(scope="module")
def sidecar(tmp_path_factory):
    home = tmp_path_factory.mktemp("home")
    sc = Sidecar(home, extra_env={"SPS_LYRICS_ENGINE": "uniform"})
    sc.ready = sc.recv(timeout=120)
    yield sc
    sc.close()


@pytest.fixture
def vocals(tmp_path):
    sr = 16000
    gap = np.zeros(sr // 2, dtype=np.float32)
    voice = np.concatenate([gap, sine(220, sr, 4.0, 0.3), gap])
    return write_wav(tmp_path / "vocals.wav", voice, sr)


def test_align_lyrics_returns_timed_lines_and_streams_progress(sidecar, vocals, tmp_path):
    msg, progress = sidecar.call(
        {"cmd": "align_lyrics", "vocalsPath": vocals, "lyrics": "hello there\nsecond line", "modelsDir": str(tmp_path)},
        timeout=60,
    )
    assert msg["type"] == "result" and msg["cmd"] == "align_lyrics"
    data = msg["data"]
    assert [l["text"] for l in data["lines"]] == ["hello there", "second line"]
    starts = [l["start"] for l in data["lines"]]
    assert 0.0 <= starts[0] < starts[1] <= 5.0
    assert progress and all(p["cmd"] == "align_lyrics" for p in progress)
    assert progress[-1]["value"] == 1.0
    assert data["totalWords"] == 4


def test_align_lyrics_reports_a_missing_file_as_an_error_message(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "align_lyrics", "vocalsPath": str(tmp_path / "gone.wav"), "lyrics": "la la"})
    assert msg["type"] == "error" and msg["cmd"] == "align_lyrics"
    assert "not found" in msg["message"]


def test_align_lyrics_requires_the_text(sidecar, vocals):
    msg, _ = sidecar.call({"cmd": "align_lyrics", "vocalsPath": vocals, "lyrics": ""})
    assert msg["type"] == "error" and "no words" in msg["message"]


def test_the_loop_survives_a_failed_lyrics_command(sidecar):
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"
