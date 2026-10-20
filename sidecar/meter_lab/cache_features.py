"""
Computes `meter.beat_features` for every reference song once and keeps it in results/features.pkl, so a change to how
the bar length or the downbeat is chosen can be tried in seconds instead of re-reading 17 songs.

    python -m meter_lab.cache_features
"""
import glob
import json
import pickle
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import meter  # noqa: E402


def main() -> int:
    out = HERE / "results" / "features.pkl"
    cache = pickle.loads(out.read_bytes()) if out.exists() else {}
    for path in sorted(glob.glob(str(HERE / "datasets" / "reference" / "*.json"))):
        ref = json.load(open(path, encoding="utf-8"))
        if ref["name"] in cache:
            continue
        song = Path(ref["song_dir"])
        stems = {n: str(song / f"{n}.wav") for n in ("drums", "bass", "guitar", "piano", "other", "vocals") if (song / f"{n}.wav").exists()}
        cache[ref["name"]] = meter.beat_features(stems)
        out.write_bytes(pickle.dumps(cache))
        print(ref["name"], "ok" if cache[ref["name"]] is not None else "no beat", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
