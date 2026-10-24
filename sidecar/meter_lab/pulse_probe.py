"""P1 probe: the existing beat tracker's interval against the reference unit of each song."""
import collections, glob, json, sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import processor

OK = (0.5, 1.0, 2.0)

def unit_period(ref):
    bars = ref["bars"]
    meters = collections.Counter((b["num"], b["den"]) for b in bars)
    (num, den), _ = meters.most_common(1)[0]
    d = [bars[i + 1]["time"] - bars[i]["time"] for i in range(len(bars) - 1) if (bars[i]["num"], bars[i]["den"]) == (num, den)]
    return float(np.median(d)) / num, num, den

def main():
    for f in sorted(glob.glob(str(Path(__file__).parent / "datasets/reference/*.json"))):
        ref = json.load(open(f))
        stems = {n: str(Path(ref["song_dir"]) / f"{n}.wav") for n in ("drums", "bass", "guitar", "piano", "other", "vocals") if (Path(ref["song_dir"]) / f"{n}.wav").exists()}
        frames = processor._beat_frames(stems)
        u, num, den = unit_period(ref)
        if frames is None:
            print(f"{ref['name']:17} no usable beat grid"); continue
        iv = float(np.median(np.diff(frames))) * processor._CHORD_HOP_LENGTH / processor.SAMPLE_RATE
        r = iv / u
        allowed = list(OK) + ([3.0] if den == 8 and num % 3 == 0 else [])
        hit = any(abs(r / a - 1) <= 0.04 for a in allowed)
        print(f"{ref['name']:17} {ref['set']:8} dom {num}/{den}  unit {u:.3f}s  beat {iv:.3f}s  ratio {r:5.2f}  {'OK' if hit else 'MISS'}", flush=True)

main()
