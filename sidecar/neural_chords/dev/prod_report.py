import json
import numpy as np
rows = json.load(open("prod_results.json"))
levels = ("root", "majmin", "sevenths")
rng = np.random.default_rng(0)
def per(setname, system, level):
    return {r["song"]: (r["levels"][level]["score"], r["levels"][level]["scored_seconds"]) for r in rows if r["set"] == setname and r["system"] == system}
def weighted(d):
    t = sum(s for _, s in d.values()); return sum(v * s for v, s in d.values()) / t
def paired(a, b):
    songs = sorted(set(a) & set(b)); d = np.array([a[s][0] - b[s][0] for s in songs])
    m = rng.integers(0, len(d), size=(4000, len(d))); means = d[m].mean(axis=1)
    return d.mean(), np.percentile(means, 2.5), np.percentile(means, 97.5), d
for setname in ("tabs", "isophonics"):
    n = len(per(setname, "classic", "root"))
    print(f"\n=== {setname} ({n} songs){'  [contaminated for BTC]' if setname == 'isophonics' else ''}")
    for sy in ("classic", "neural"):
        print(f"{sy:<8}" + "".join(f"{l} {weighted(per(setname, sy, l)) * 100:5.1f}   " for l in levels))
    line = "paired neural - classic: "
    for l in levels:
        m, lo, hi, d = paired(per(setname, "neural", l), per(setname, "classic", l))
        line += f"{l} {m*100:+.1f} [{lo*100:+.1f},{hi*100:+.1f}]  "
    print(line)
    for l in ("majmin", "sevenths"):
        _, _, _, d = paired(per(setname, "neural", l), per(setname, "classic", l))
        print(f"   {l}: neural better on {int((d > 0).sum())}/{len(d)} songs, worst {d.min()*100:+.1f}, best {d.max()*100:+.1f}")
ts = {s: [r["seconds"] for r in rows if r["system"] == s] for s in ("classic", "neural")}
print("\nseconds per song (production path, incl. loading the stems): classic median", round(float(np.median(ts["classic"]))), "neural median", round(float(np.median(ts["neural"]))))
print("segments per song, median: classic", int(np.median([r["segments"] for r in rows if r["system"] == "classic"])), "neural", int(np.median([r["segments"] for r in rows if r["system"] == "neural"])))
