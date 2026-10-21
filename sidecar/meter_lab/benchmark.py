"""
Scores meter.detect_meter against the reference bar maps (see reference.py) with the metrics of
wiki/meter-detection.md:

    P1  the beat the detector counted in is the reference unit's period times 0.5, 1 or 2 (3 for a compound meter)
    P2  the bar length it found, in the reference unit, is the one the song is mostly in
    P3  F1 of the bar starts it found against the reference's, within 70 ms

    python -m meter_lab.benchmark                  # every reference song
    python -m meter_lab.benchmark money schism     # some
"""
import collections
import glob
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

import meter  # noqa: E402

RATIOS = (0.5, 1.0, 2.0)
TOLERANCE = 0.04
HIT_SECONDS = 0.07


def dominant(ref: dict) -> tuple:
    counts = collections.Counter((b["num"], b["den"]) for b in ref["bars"])
    (num, den), _ = counts.most_common(1)[0]
    return num, den


def unit_period(ref: dict, num: int, den: int) -> float:
    bars = ref["bars"]
    lengths = [bars[i + 1]["time"] - bars[i]["time"] for i in range(len(bars) - 1) if (bars[i]["num"], bars[i]["den"]) == (num, den)]
    return float(np.median(lengths)) / num


def pulse_ratio(detected: dict, unit: float) -> float:
    bars = detected["bars"]
    lengths = [bars[i + 1]["start"] - bars[i]["start"] for i in range(len(bars) - 1)]
    return float(np.median(lengths)) / bars[0]["num"] / unit


def f1(found: list, wanted: list, tolerance: float = HIT_SECONDS) -> float:
    if not found or not wanted:
        return 0.0
    found, wanted = np.array(sorted(found)), np.array(sorted(wanted))
    hits = sum(1 for t in found if np.abs(wanted - t).min() <= tolerance)
    hit_wanted = sum(1 for t in wanted if np.abs(found - t).min() <= tolerance)
    precision, recall = hits / len(found), hit_wanted / len(wanted)
    return 0.0 if precision + recall == 0 else 2 * precision * recall / (precision + recall)


def score(ref: dict, detected: dict | None) -> dict:
    num, den = dominant(ref)
    out = {"name": ref["name"], "set": ref["set"], "reference": f"{num}/{den}", "p1": False, "p2": False, "f1": 0.0}
    if not detected:
        return {**out, "found": "none"}
    unit = unit_period(ref, num, den)
    ratio = pulse_ratio(detected, unit)
    allowed = list(RATIOS) + ([3.0] if den == 8 and num % 3 == 0 else [])
    near = [a for a in allowed if abs(ratio / a - 1) <= TOLERANCE]
    found = detected["bars"][0]
    out.update({"found": f"{found['num']}/{found['den']}", "ratio": round(ratio, 2), "confidence": detected.get("confidence")})
    out["p1"] = bool(near)
    if near:
        out["p2"] = abs(found["num"] * near[0] - num) < 1e-9 or abs(found["num"] - num / near[0]) < 1e-9
    out["f1"] = round(f1([b["start"] for b in detected["bars"]], [b["time"] for b in ref["bars"]]), 2)
    return out


def main(argv: list) -> int:
    wanted = {a.lower() for a in argv}
    rows = []
    for path in sorted(glob.glob(str(HERE / "datasets" / "reference" / "*.json"))):
        ref = json.load(open(path, encoding="utf-8"))
        if wanted and ref["name"] not in wanted:
            continue
        song = Path(ref["song_dir"])
        stems = {n: str(song / f"{n}.wav") for n in ("drums", "bass", "guitar", "piano", "other", "vocals") if (song / f"{n}.wav").exists()}
        row = score(ref, meter.detect_meter(stems))
        rows.append(row)
        print(
            f"{row['name']:17} {row['set']:8} ref {row['reference']:>5}  found {row['found']:>5}  "
            f"pulse {'ok  ' if row['p1'] else 'MISS'}  length {'ok  ' if row['p2'] else 'MISS'}  F1 {row['f1']:.2f}  conf {row.get('confidence')}",
            flush=True,
        )
    for group in ("constant", "odd"):
        part = [r for r in rows if r["set"] == group]
        if part:
            print(f"{group:8} n={len(part)}  P1 {sum(r['p1'] for r in part)}/{len(part)}  P2 {sum(r['p2'] for r in part)}/{len(part)}  mean F1 {np.mean([r['f1'] for r in part]):.2f}")
    out = HERE / "results" / "benchmark.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(rows, indent=1), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
