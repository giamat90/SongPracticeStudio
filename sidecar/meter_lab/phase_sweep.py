"""
Tries ways of choosing the first beat of the bar on the cached frame features (cache_features.py), scoring each by
the F1 of the bar starts it gives against the reference, with the bar length the detector chose.

Tune on `constant`, then look at `odd` once: the protocol in wiki/meter-detection.md.

    python -m meter_lab.phase_sweep
"""
import glob
import json
import pickle
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import meter  # noqa: E402
from meter_lab.benchmark import f1  # noqa: E402

z = meter._z


def by_feature(*weights):
    def rule(f, n):
        score = sum(w * z(f[k]) for k, w in weights)
        phase = np.arange(len(score)) % n
        return int(np.argmax([score[phase == p].mean() for p in range(n)]))
    return rule


def backbeat(f, n):
    """Kick, bass and harmony on the first beat, and for even bars hats on the beats between."""
    low, high, bass, nov = z(f["low"]), z(f["high"]), z(f["bass"]), z(f["novelty"])
    best, best_p = -1e9, 0
    for p in range(n):
        pos = (np.arange(len(low)) - p) % n
        first = low[pos == 0].mean() + bass[pos == 0].mean() + nov[pos == 0].mean()
        back = high[pos % 2 == 1].mean() - high[pos % 2 == 0].mean() if n % 2 == 0 else 0.0
        score = first + 0.8 * back
        if score > best:
            best, best_p = score, p
    return best_p


RULES = {
    "current: kick + bass + harmony + 0.4 hats": by_feature(("low", 1), ("bass", 1), ("novelty", 1), ("high", 0.4)),
    "kick only": by_feature(("low", 1)),
    "bass only": by_feature(("bass", 1)),
    "harmony change only": by_feature(("novelty", 1)),
    "kick + bass": by_feature(("low", 1), ("bass", 1)),
    "kick + harmony": by_feature(("low", 1), ("novelty", 1)),
    "bass + harmony": by_feature(("bass", 1), ("novelty", 1)),
    "2 kick + 1 bass + 1 harmony": by_feature(("low", 2), ("bass", 1), ("novelty", 1)),
    "backbeat": backbeat,
}


def main() -> int:
    frames = pickle.loads((HERE / "results" / "frames.pkl").read_bytes())
    refs = {}
    for path in sorted(glob.glob(str(HERE / "datasets" / "reference" / "*.json"))):
        ref = json.load(open(path, encoding="utf-8"))
        refs[ref["name"]] = ref
    print(f"{'onset windows / rule':58} {'constant (tuning)':>18} {'odd (held out)':>16}")
    for centred in (False, True):
        feats = {song: meter.beat_features_from(f, centred) for song, f in frames.items() if f is not None}
        for name, rule in RULES.items():
            scores = {"constant": [], "odd": []}
            for song, f in feats.items():
                n = meter.choose_bar_length(meter.bar_length_scores(f))
                cut = meter.bars_from_beats(f["times"], n, rule(f, n), 4, 1e9)
                ref = refs[song]
                scores[ref["set"]].append(f1([b["start"] for b in cut["bars"]], [b["time"] for b in ref["bars"]]))
            label = f"{'centred' if centred else 'forward'}: {name}"
            print(f"{label:58} {np.mean(scores['constant']):>12.2f} ({len(scores['constant'])}) {np.mean(scores['odd']):>10.2f} ({len(scores['odd'])})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
