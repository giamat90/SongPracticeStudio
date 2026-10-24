#!/usr/bin/env python3
"""
End-to-end smoke test for a built sidecar binary.

Spawns the exe, waits for "ready", sends a "process" command against a tiny
bundled WAV, and asserts a "result" comes back with real stem files. This
exercises the full pipeline (ffmpeg decode, torch model inference, soundfile
write, librosa BPM/key, bass tab transcription) inside the frozen exe — a
plain "does the exe launch" check does not touch any of this and would not
have caught the missing-ffmpeg-on-PATH bug that shipped in an earlier build.

Only requests vocals/drums/bass/other so a single Demucs pass (htdemucs) runs
instead of the guitar/piano cascade, keeping CI time and model-download size
down while still covering every native dependency in the chain.

Usage: python smoke_test.py <path-to-sidecar-exe>
"""
import json
import os
import subprocess
import sys
import tempfile
import time

READY_TIMEOUT_S = 30
PROCESS_TIMEOUT_S = 900  # first run downloads Demucs model weights


def read_until(proc, wanted_types, timeout):
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        print(f"[sidecar] {line}")
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        if msg.get("type") in wanted_types:
            return msg
    return None


def main():
    if len(sys.argv) != 2:
        print("Usage: smoke_test.py <sidecar-exe>", file=sys.stderr)
        sys.exit(2)

    exe = sys.argv[1]
    if not os.path.isfile(exe):
        print(f"FAIL: sidecar binary not found: {exe}", file=sys.stderr)
        sys.exit(2)

    test_wav = os.path.join(os.path.dirname(__file__), "testdata", "smoke_test.wav")
    if not os.path.isfile(test_wav):
        print(f"FAIL: missing test fixture: {test_wav}", file=sys.stderr)
        sys.exit(2)

    with tempfile.TemporaryDirectory() as out_dir:
        proc = subprocess.Popen(
            [exe],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        try:
            ready = read_until(proc, {"ready"}, READY_TIMEOUT_S)
            if ready is None:
                print("FAIL: sidecar never sent 'ready'", file=sys.stderr)
                sys.exit(1)

            cmd = {
                "cmd": "process",
                "filePath": test_wav,
                "outputDir": out_dir,
                "stemsToExtract": ["vocals", "drums", "bass", "other"],
            }
            proc.stdin.write(json.dumps(cmd) + "\n")
            proc.stdin.flush()

            outcome = read_until(proc, {"result", "error"}, PROCESS_TIMEOUT_S)
            if outcome is None:
                print("FAIL: no result/error before timeout", file=sys.stderr)
                sys.exit(1)
            if outcome.get("type") == "error":
                print(f"FAIL: sidecar returned error: {outcome}", file=sys.stderr)
                sys.exit(1)

            stems = outcome.get("data", {}).get("stems", {})
            missing = [name for name, path in stems.items() if not os.path.isfile(path)]
            if not stems or missing:
                print(f"FAIL: no stems produced or files missing: {outcome}", file=sys.stderr)
                sys.exit(1)

            print(f"PASS: produced {len(stems)} stems: {list(stems)}")
        finally:
            try:
                proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                proc.stdin.flush()
            except (BrokenPipeError, ValueError):
                pass
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


if __name__ == "__main__":
    main()
