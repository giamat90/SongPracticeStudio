#!/usr/bin/env python3
"""
Downloads the pretrained weights of the neural chord engine (BTC, ~12 MB) into
vendor/btc/, from a pinned upstream commit, and checks the SHA-256 against the
one the engine insists on. Not part of the default build: the neural engine is
an opt-in beta, and without the file it falls back to the classical detector.

Safe to re-run; skips a file that already matches.
Usage: python fetch_btc.py
"""
import sys
import urllib.request
from pathlib import Path

from neural_chords import engine

DEST = Path(__file__).parent / "vendor" / "btc" / engine.WEIGHTS_NAME


def main() -> int:
    if DEST.is_file() and engine.sha256_of(DEST) == engine.WEIGHTS_SHA256:
        print(f"Already present: {DEST}")
        return 0
    DEST.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {engine.WEIGHTS_URL}")
    tmp = DEST.with_suffix(".part")
    urllib.request.urlretrieve(engine.WEIGHTS_URL, tmp)
    found = engine.sha256_of(tmp)
    if found != engine.WEIGHTS_SHA256:
        tmp.unlink()
        print(f"SHA-256 mismatch: expected {engine.WEIGHTS_SHA256}, got {found}", file=sys.stderr)
        return 1
    tmp.replace(DEST)
    print(f"Saved {DEST}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
