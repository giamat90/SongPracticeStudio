"""The real `python main.py` process, driven exactly like Rust's SidecarManager does: JSON lines over stdio."""

import json
import os
import queue
import subprocess
import sys
import threading

import numpy as np
import pytest
import soundfile as sf

from helpers import harmonic_tone, sine, write_wav

pytestmark = pytest.mark.slow

SR = 22050


class Sidecar:
    def __init__(self, home):
        env = {**os.environ, "USERPROFILE": str(home), "HOME": str(home), "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
        self.proc = subprocess.Popen(
            [sys.executable, "main.py"],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
        )
        self.lines: "queue.Queue[bytes]" = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        for line in self.proc.stdout:
            self.lines.put(line)
        self.lines.put(b"")

    def send(self, obj):
        self.send_raw(json.dumps(obj))

    def send_raw(self, text):
        self.proc.stdin.write((text + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def recv(self, timeout=60):
        line = self.lines.get(timeout=timeout)
        assert line != b"", "sidecar closed stdout"
        return json.loads(line.decode("utf-8"))

    def final(self, timeout=120):
        """Everything up to (and including) the first non-progress message."""
        progress = []
        while True:
            msg = self.recv(timeout)
            if msg["type"] == "progress":
                progress.append(msg)
            else:
                return msg, progress

    def call(self, obj, timeout=120):
        self.send(obj)
        return self.final(timeout)

    def close(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()


@pytest.fixture(scope="module")
def sidecar(tmp_path_factory):
    home = tmp_path_factory.mktemp("home")
    sc = Sidecar(home)
    ready = sc.recv(timeout=120)
    sc.ready = ready
    yield sc
    sc.close()


@pytest.fixture(scope="module")
def work(tmp_path_factory):
    d = tmp_path_factory.mktemp("work")
    write_wav(d / "tone.wav", harmonic_tone(220, SR, 2.0), SR)
    return d


def test_announces_readiness_first(sidecar):
    assert sidecar.ready["type"] == "ready"
    assert "advisory" in sidecar.ready


def test_ping_pong(sidecar):
    assert sidecar.call({"cmd": "ping"})[0] == {"type": "pong"}


def test_invalid_json_is_reported_and_the_loop_survives(sidecar):
    sidecar.send_raw("{broken")
    msg, _ = sidecar.final(30)
    assert msg["type"] == "error" and "Invalid JSON" in msg["message"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_blank_lines_are_ignored(sidecar):
    sidecar.send_raw("")
    sidecar.send_raw("   ")
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_unknown_commands_are_reported_by_name(sidecar):
    msg, _ = sidecar.call({"cmd": "make_coffee"})
    assert msg["type"] == "error" and "Unknown command: make_coffee" in msg["message"]


def test_a_command_without_a_cmd_field_is_an_unknown_command(sidecar):
    msg, _ = sidecar.call({"hello": 1})
    assert msg["type"] == "error" and "Unknown command" in msg["message"]


def test_a_command_missing_a_required_argument_returns_a_traceback_not_a_crash(sidecar):
    msg, _ = sidecar.call({"cmd": "convert_take"})
    assert msg["type"] == "error" and msg["cmd"] == "convert_take"
    assert "recordingPath" in msg["message"] and "Traceback" in msg["traceback"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_an_exception_inside_a_command_is_reported_with_the_command_name(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "convert_take", "recordingPath": str(tmp_path / "missing.webm"), "outputPath": str(tmp_path / "o.wav")})
    assert msg["type"] == "error" and msg["cmd"] == "convert_take"


def test_convert_take(sidecar, work, tmp_path):
    msg, _ = sidecar.call({"cmd": "convert_take", "recordingPath": str(work / "tone.wav"), "outputPath": str(tmp_path / "o.wav")})
    assert msg == {"type": "result", "cmd": "convert_take", "data": {"path": str(tmp_path / "o.wav")}}
    assert sf.info(str(tmp_path / "o.wav")).samplerate == SR


def test_mix_export_places_a_take_where_the_project_timeline_says(sidecar, tmp_path):
    stem = tmp_path / "stem.wav"
    sf.write(str(stem), np.full(8000 * 6, 0.1, dtype=np.float32), 8000, subtype="FLOAT")
    take = tmp_path / "take.wav"
    sf.write(str(take), np.full(8000 * 2, 0.3, dtype=np.float32), 8000, subtype="FLOAT")
    sources = [
        {"path": str(stem), "gain": 1.0, "isTake": False},
        {"path": str(take), "gain": 1.0, "isTake": True, "startPosition": 3.0, "audioOffset": 0.0, "manualOffset": 0.0},
    ]
    msg, _ = sidecar.call({"cmd": "mix_export", "sources": sources, "startSec": 2.0, "endSec": 6.0, "outputPath": str(tmp_path / "mix.wav")})
    assert msg["type"] == "result"
    data, sr = sf.read(str(tmp_path / "mix.wav"), dtype="float32")
    assert data[int(0.5 * sr), 0] == pytest.approx(0.1, abs=1e-3)
    assert data[int(1.5 * sr), 0] == pytest.approx(0.4, abs=1e-3)


def test_mix_export_with_no_sources_is_an_error(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "mix_export", "sources": [], "startSec": 0, "endSec": 1, "outputPath": str(tmp_path / "x.wav")})
    assert msg["type"] == "error" and "at least one source" in msg["message"]


def test_normalize_take_matches_the_reference_loudness(sidecar, tmp_path):
    ref = write_wav(tmp_path / "ref.wav", harmonic_tone(300, SR, 2.0, amp=0.05), SR)
    take = write_wav(tmp_path / "take.wav", harmonic_tone(220, SR, 2.0, amp=0.6), SR)
    msg, _ = sidecar.call({"cmd": "normalize_take", "recordingPath": take, "outputPath": str(tmp_path / "n.wav"), "referencePath": ref, "audioOffset": 0.25})
    assert msg["type"] == "result" and msg["cmd"] == "normalize_take"
    assert msg["data"]["path"] == str(tmp_path / "n.wav") and msg["data"]["appliedGainDb"] < 0
    out, sr = sf.read(str(tmp_path / "n.wav"))
    assert sr == SR and len(out) == pytest.approx(2.0 * SR, abs=SR * 0.02), "the whole file is kept; the player skips audioOffset itself"


def test_normalize_take_without_a_reference(sidecar, tmp_path):
    take = write_wav(tmp_path / "take.wav", harmonic_tone(220, SR, 1.0, amp=0.5), SR)
    msg, _ = sidecar.call({"cmd": "normalize_take", "recordingPath": take, "outputPath": str(tmp_path / "n.wav")})
    assert msg["type"] == "result" and "appliedGainDb" in msg["data"]


def test_pitch_shift_writes_every_named_stem_and_streams_progress(sidecar, tmp_path):
    song = tmp_path / "song"
    cache = tmp_path / "cache"
    song.mkdir()
    cache.mkdir()
    for name in ("vocals.wav", "drums.wav"):
        write_wav(song / name, sine(220, SR, 1.0), SR)
    msg, progress = sidecar.call({"cmd": "pitch_shift", "songDir": str(song), "cacheDir": str(cache), "stemNames": ["vocals", "drums"], "nSteps": 2})
    assert msg["type"] == "result" and msg["cmd"] == "pitch_shift"
    assert msg["data"]["stems"] == {"vocals": str(cache / "vocals.wav"), "drums": str(cache / "drums.wav")}
    assert all(os.path.exists(p) for p in msg["data"]["stems"].values())
    assert progress and progress[-1]["value"] == 1.0 and all(p["cmd"] == "pitch_shift" for p in progress)


def test_process_of_a_missing_file_reports_an_error_naming_the_command(sidecar, tmp_path):
    msg, _ = sidecar.call({"cmd": "process", "filePath": str(tmp_path / "gone.mp3"), "outputDir": str(tmp_path / "o"), "stemsToExtract": ["vocals"]}, timeout=180)
    assert msg["type"] == "error" and msg["cmd"] == "process" and "Traceback" in msg["traceback"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_process_with_an_empty_stem_list_is_rejected_up_front(sidecar, work, tmp_path):
    msg, _ = sidecar.call({"cmd": "process", "filePath": str(work / "tone.wav"), "outputDir": str(tmp_path / "o"), "stemsToExtract": []}, timeout=180)
    assert msg["type"] == "error" and "No valid stems" in msg["message"]


def test_import_yt_without_a_url_is_an_error_not_a_crash(sidecar):
    msg, _ = sidecar.call({"cmd": "import_yt", "outputDir": "x"})
    assert msg["type"] == "error" and msg["cmd"] == "import_yt" and "url" in msg["message"]
    assert sidecar.call({"cmd": "ping"})[0]["type"] == "pong"


def test_non_ascii_paths_round_trip(sidecar, tmp_path):
    folder = tmp_path / "Música – 日本語 ñ"
    folder.mkdir()
    path = write_wav(folder / "tóno.wav", sine(440, SR, 1.0), SR)
    msg, _ = sidecar.call({"cmd": "convert_take", "recordingPath": path, "outputPath": str(folder / "salida.wav")})
    assert msg["type"] == "result"
    assert msg["data"]["path"] == str(folder / "salida.wav")


def test_quit_says_bye_and_exits_cleanly(tmp_path_factory):
    sc = Sidecar(tmp_path_factory.mktemp("quit-home"))
    try:
        assert sc.recv(timeout=120)["type"] == "ready"
        assert sc.call({"cmd": "quit"})[0] == {"type": "bye"}
        assert sc.proc.wait(timeout=20) == 0
    finally:
        sc.close()


def test_closing_stdin_ends_the_process(tmp_path_factory):
    sc = Sidecar(tmp_path_factory.mktemp("eof-home"))
    try:
        assert sc.recv(timeout=120)["type"] == "ready"
        sc.proc.stdin.close()
        assert sc.proc.wait(timeout=20) == 0
    finally:
        sc.close()


def test_every_command_the_rust_side_sends_is_handled():
    """Rust emits these `cmd` values (grep of commands.rs); each must have a branch in main.py."""
    from pathlib import Path
    import re

    rust = (Path(__file__).resolve().parents[2] / "src-tauri" / "src" / "commands.rs").read_text(encoding="utf-8")
    sent = set(re.findall(r'"cmd":\s*"(\w+)"', rust))
    main_py = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    handled = set(re.findall(r'cmd\.get\("cmd"\) == "(\w+)"', main_py))
    assert sent, "regex found no commands in commands.rs"
    assert sent <= handled, f"Rust sends commands main.py does not handle: {sent - handled}"


def test_the_commands_main_py_handles_are_exactly_the_ones_documented():
    from pathlib import Path
    import re

    main_py = (Path(__file__).resolve().parents[1] / "main.py").read_text(encoding="utf-8")
    handled = set(re.findall(r'cmd\.get\("cmd"\) == "(\w+)"', main_py))
    assert handled == {"process", "import_yt", "convert_take", "normalize_take", "mix_export", "pitch_shift", "ping", "quit"}


def test_a_failing_freshness_check_is_logged_and_does_not_block_startup(monkeypatch, capsys):
    import io

    import main

    def boom():
        raise RuntimeError("network down")

    monkeypatch.setattr(main, "check_yt_dlp_freshness", boom)
    monkeypatch.setattr(main.sys, "stdin", io.StringIO(""))
    main.main()
    captured = capsys.readouterr()
    assert '"type": "ready"' in captured.out and '"advisory": null' in captured.out
    assert "network down" in captured.err
