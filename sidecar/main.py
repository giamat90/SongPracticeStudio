#!/usr/bin/env python3
"""
VPS Python Sidecar
Communicates with Tauri shell via JSON lines on stdin/stdout.
Commands execute synchronously on the main thread to avoid GIL/numpy
deadlocks that occur with background threads on Windows.
"""

import sys
import json
import traceback

from processor import process
from analysis import analyze_recording


def send(msg: dict):
    sys.stdout.write(json.dumps(msg) + "\n")
    sys.stdout.flush()


def make_progress_callback(cmd_name: str):
    def callback(value: float, stage: str):
        send({"type": "progress", "cmd": cmd_name, "stage": stage, "value": round(value, 3)})
    return callback


def main():
    send({"type": "ready"})

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
                    on_progress=make_progress_callback("process"),
                )
                send({"type": "result", "cmd": "process", "data": result})

            elif cmd.get("cmd") == "analyze":
                result = analyze_recording(
                    cmd["recordingPath"],
                    cmd["outputDir"],
                    on_progress=make_progress_callback("analyze"),
                )
                send({"type": "result", "cmd": "analyze", "data": result})

            elif cmd.get("cmd") == "pitch_shift":
                from processor import pitch_shift_song
                result = pitch_shift_song(
                    cmd["songDir"],
                    cmd["cacheDir"],
                    cmd["nSteps"],
                    on_progress=make_progress_callback("pitch_shift"),
                )
                send({"type": "result", "cmd": "pitch_shift", "data": result})

            elif cmd.get("cmd") == "import_yt":
                from yt_importer import import_yt
                result = import_yt(
                    cmd["url"],
                    cmd["outputDir"],
                    on_progress=make_progress_callback("import_yt"),
                )
                send({"type": "result", "cmd": "import_yt", "data": result})

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
