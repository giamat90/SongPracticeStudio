"""Score the production path (processor._detect_chords_full) with each engine on both data sets, same protocol as before."""
import sys, os, json, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np
import processor, chord_eval

OUT = sys.argv[1]
DATA = Path(os.environ.get("CHORD_LAB_DATASETS") or Path(__file__).resolve().parents[2] / "chord_lab" / "datasets")
rows = []
for setname in ("tabs", "isophonics"):
    base = DATA / setname
    songs = json.loads((base / "manifest.json").read_text(encoding="utf-8"))["songs"]
    for e in songs:
        song_dir = (base / Path(e["song_dir"]).expanduser()).resolve()
        ref = chord_eval.read_lab((base / e["ref"]).resolve())
        stems, source = chord_eval._stem_paths(song_dir)
        for engine in ("classic", "neural"):
            os.environ["SPS_CHORD_ENGINE"] = engine
            t0 = time.time()
            segs, duration, cents = processor._detect_chords_full(stems, source)
            dt = time.time() - t0
            off = chord_eval.best_offset(ref, segs)["offset"]
            r = chord_eval.evaluate(ref, chord_eval.shift(segs, off), duration)
            rows.append({"set": setname, "song": e["name"], "system": engine, "seconds": dt, "segments": len(segs), "offset": off, "tuning": cents,
                         "levels": {l: {"score": r["levels"][l]["score"], "scored_seconds": r["levels"][l]["scored_seconds"]} for l in chord_eval.LEVELS}})
            print(setname, e["name"], engine, round(r["levels"]["majmin"]["score"] * 100, 1), f"{dt:.0f}s", len(segs), "segs", flush=True)
        json.dump(rows, open(OUT, "w"))
print("DONE", flush=True)
