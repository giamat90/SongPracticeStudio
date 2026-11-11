"""usage: live_sweep.py OUT.jsonl SET "k=v,k=v" ["k=v" ...]  - one engine run per config over every song of SET"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lab, live, realtime as rt, processor

out, setname, configs = sys.argv[1], sys.argv[2], sys.argv[3:]
dataset = lab.load_set(setname)
mixes = {}
for cfg in configs:
    kv = {k: float(v) for k, v in (p.split("=") for p in cfg.split(",") if p)}
    settings = rt.Settings(**kv)
    results = []
    for entry in dataset.songs:
        if entry["name"] not in mixes:
            mixes = {entry["name"]: live.song_mix(entry["song_dir"], None)}
        frames = live.run_engine(mixes[entry["name"]], processor.SAMPLE_RATE, settings)
        r = live.score_frames(frames, settings, entry["ref"], len(frames) * settings.hop, 0.3, True)
        r["name"] = entry["name"]; r.pop("segments"); results.append(r)
    row = {"set": setname, "config": cfg, **{lvl: lab.weighted(results, lvl) for lvl in lab.LEVELS}}
    open(out, "a").write(json.dumps(row) + "\n")
    print(row, flush=True)
