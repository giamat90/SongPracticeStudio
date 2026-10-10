#!/usr/bin/env python3
"""
Song Practice Studio Python Sidecar
Communicates with Tauri shell via JSON lines on stdin/stdout.
Commands execute synchronously on the main thread to avoid GIL/numpy
deadlocks that occur with background threads on Windows.
"""

import os
import sys
import json
import traceback

# The JSON-lines protocol with the Rust shell is UTF-8. On Windows, Python
# otherwise decodes stdin/stdout with the console codepage (e.g. cp1252), which
# mangles non-ASCII file paths and surfaces as a misleading ffmpeg/ffprobe
# failure. Belt-and-suspenders with PYTHONUTF8/PYTHONIOENCODING set by the shell.
for _stream in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

# When frozen by PyInstaller (--onefile), any bundled ffmpeg binary is
# extracted to sys._MEIPASS on launch. Demucs shells out to a bare `ffmpeg`
# on PATH to decode audio, so without this the installed app fails on every
# file unless the end user happens to have ffmpeg on their system PATH.
if getattr(sys, "frozen", False):
    bundled_dir = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
    os.environ["PATH"] = bundled_dir + os.pathsep + os.environ.get("PATH", "")

from processor import process
from recording import convert_take_to_wav, mix_export, normalize_take
from mps_core import lyrics
from mps_core.app import AppIdentity
from mps_core.version_check import check_yt_dlp_freshness

APP = AppIdentity(
    name="SongPracticeStudio",
    url="https://github.com/giamat90/SongPracticeStudio",
    data_dir="~/.songpracticestudio",
    env_prefix="SPS",
)


def send(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def make_progress_callback(cmd_name: str):
    def callback(value: float, stage: str):
        send({"type": "progress", "cmd": cmd_name, "stage": stage, "value": round(value, 3)})
    return callback


def main():
    try:
        advisory = check_yt_dlp_freshness(APP)
    except Exception as e:
        print(f"yt-dlp freshness check failed: {e}", file=sys.stderr, flush=True)
        advisory = None
    send({"type": "ready", "advisory": advisory})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            send({"type": "error", "message": f"Invalid JSON: {line}"})
            continue

        try:
            if cmd.get("cmd") == "process":
                result = process(
                    cmd["filePath"],
                    cmd["outputDir"],
                    stems_to_extract=cmd.get("stemsToExtract"),
                    high_quality=bool(cmd.get("highQuality", False)),
                    on_progress=make_progress_callback("process"),
                )
                send({"type": "result", "cmd": "process", "data": result})

            elif cmd.get("cmd") == "import_yt":
                from yt_importer import import_yt
                result = import_yt(
                    cmd["url"],
                    cmd["outputDir"],
                    stems_to_extract=cmd.get("stemsToExtract"),
                    high_quality=bool(cmd.get("highQuality", False)),
                    on_progress=make_progress_callback("import_yt"),
                    cookies_path=cmd.get("cookiesPath"),
                )
                send({"type": "result", "cmd": "import_yt", "data": result})

            elif cmd.get("cmd") == "convert_take":
                result = convert_take_to_wav(cmd["recordingPath"], cmd["outputPath"])
                send({"type": "result", "cmd": "convert_take", "data": result})

            elif cmd.get("cmd") == "normalize_take":
                result = normalize_take(
                    cmd["recordingPath"],
                    cmd["outputPath"],
                    reference_path=cmd.get("referencePath"),
                    audio_offset_s=float(cmd.get("audioOffset", 0.0)),
                )
                send({"type": "result", "cmd": "normalize_take", "data": result})

            elif cmd.get("cmd") == "mix_export":
                result = mix_export(
                    cmd["sources"],
                    float(cmd["startSec"]),
                    float(cmd["endSec"]),
                    cmd["outputPath"],
                )
                send({"type": "result", "cmd": "mix_export", "data": result})

            elif cmd.get("cmd") == "pitch_shift":
                from processor import pitch_shift_song
                result = pitch_shift_song(
                    cmd["songDir"],
                    cmd["cacheDir"],
                    cmd["stemNames"],
                    cmd["nSteps"],
                    on_progress=make_progress_callback("pitch_shift"),
                )
                send({"type": "result", "cmd": "pitch_shift", "data": result})

            elif cmd.get("cmd") == "align_lyrics":
                result = lyrics.align_lyrics(
                    cmd["vocalsPath"],
                    cmd.get("lyrics", ""),
                    on_progress=make_progress_callback("align_lyrics"),
                    models_dir=cmd.get("modelsDir"),
                    app=APP,
                )
                send({"type": "result", "cmd": "align_lyrics", "data": result})

            elif cmd.get("cmd") == "find_lyrics":
                result = lyrics.find_lyrics(
                    cmd["title"],
                    artist=cmd.get("artist"),
                    duration=cmd.get("duration"),
                    app=APP,
                )
                send({"type": "result", "cmd": "find_lyrics", "data": result})

            elif cmd.get("cmd") == "ping":
                send({"type": "pong"})

            elif cmd.get("cmd") == "quit":
                send({"type": "bye"})
                break

            else:
                send({"type": "error", "message": f"Unknown command: {cmd.get('cmd')}"})

        except Exception as e:
            send({
                "type": "error",
                "cmd": cmd.get("cmd"),
                "message": str(e),
                "traceback": traceback.format_exc(),
            })


if __name__ == "__main__":
    main()
