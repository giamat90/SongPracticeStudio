"""usage: neural_demo.py "song name" set start window - classical vs neural vs the chart, a PNG, and a WAV (song left, neural chords right)."""
import sys, os, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import numpy as np, soundfile as sf
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import processor, chord_eval

name, setname, start, window = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
OUT = Path(sys.argv[5]); OUT.mkdir(exist_ok=True)
base = Path(os.environ.get("CHORD_LAB_DATASETS") or Path(__file__).resolve().parents[2] / "chord_lab" / "datasets") / setname
entry = next(e for e in json.loads((base / "manifest.json").read_text(encoding="utf-8"))["songs"] if name.lower() in e["name"].lower())
song_dir = (base / Path(entry["song_dir"]).expanduser()).resolve()
stems, source = chord_eval._stem_paths(song_dir)
ref = chord_eval.read_lab((base / entry["ref"]).resolve())
segs, scores = {}, {}
for engine in ("classic", "neural"):
    os.environ["SPS_CHORD_ENGINE"] = engine
    s, duration, cents = processor._detect_chords_full(stems, source)
    segs[engine] = list(s)
tune_cents = cents
offset = chord_eval.best_offset(ref, segs["neural"])["offset"]
ref_on_audio = chord_eval.shift(ref, -offset)
for engine in segs:
    r = chord_eval.evaluate(ref, chord_eval.shift(segs[engine], offset), duration)
    scores[engine] = {l: r["levels"][l]["score"] * 100 for l in chord_eval.LEVELS}

def at(segments, t):
    return next((s for s in segments if s["start"] <= t < s["end"]), None)

def agreement(det, times):
    out = []
    for t in times:
        r, d = at(ref_on_audio, t), at(det, t)
        want = chord_eval.simplify(r["chord"], "majmin") if r else None
        if want in (None, "N"): out.append(0); continue
        got = chord_eval.simplify(d["chord"], "majmin") if d else None
        if got == want: out.append(1)
        elif d and chord_eval.simplify(d["chord"], "root") == chord_eval.simplify(r["chord"], "root"): out.append(2)
        else: out.append(3)
    return out

NAMES = processor.NOTE_NAMES
def label(seg):
    if ":" not in seg["chord"]:
        return "" if seg["chord"] in ("N", "X") else seg["chord"]
    root, q = seg["chord"].split(":")
    suffix = {"maj": "", "min": "m", "7": "7", "maj7": "maj7", "min7": "m7"}.get(q, q)
    text = root + suffix
    return text + ("/" + seg["bass"] if seg.get("bass") else "")

def draw(ax, segments, t0, t1, shade):
    ax.set_xlim(t0, t1); ax.set_ylim(0, 1); ax.set_yticks([])
    for seg in segments:
        if seg["end"] < t0 or seg["start"] > t1: continue
        a = 0.35 + 0.65 * min(1.0, max(0.0, (seg.get("confidence", 1.0) - 0.5) / 0.45)) if shade else 0.8
        root = NAMES.index(seg["chord"].split(":")[0]) if ":" in seg["chord"] else 0
        ax.axvspan(seg["start"], seg["end"], color=plt.cm.tab20c(0.04 + 0.9 * root / 12), alpha=a, lw=0)
        ax.axvline(seg["start"], color="black", lw=0.6)
        if seg["end"] - seg["start"] >= window / 55:
            ax.text((max(seg["start"], t0) + min(seg["end"], t1)) / 2, 0.5, label(seg), ha="center", va="center", fontsize=9)

t0, t1 = start, start + window
times = np.arange(t0, t1, 0.1)
fig, axes = plt.subplots(5, 1, figsize=(15, 5.6), sharex=True, gridspec_kw={"height_ratios": [1.3, 1.3, 0.35, 1.3, 0.35]})
fig.subplots_adjust(left=0.1, right=0.99, top=0.88, bottom=0.08, hspace=0.12)
draw(axes[0], ref_on_audio, t0, t1, False); axes[0].set_ylabel("your tab", rotation=0, ha="right", va="center")
draw(axes[1], segs["classic"], t0, t1, True); axes[1].set_ylabel("classical", rotation=0, ha="right", va="center")
draw(axes[3], segs["neural"], t0, t1, True); axes[3].set_ylabel("neural", rotation=0, ha="right", va="center")
colours = ["#555555", "#3a9d5d", "#d9a21b", "#c0392b"]
for ax, key in ((axes[2], "classic"), (axes[4], "neural")):
    ax.set_yticks([]); ax.set_xlim(t0, t1)
    for t, c in zip(times, agreement(segs[key], times)):
        if c: ax.axvspan(t, t + 0.1, color=colours[c], lw=0)
axes[4].set_xlabel("seconds")
fig.suptitle(f"{entry['name']}   |   whole song, root / major-minor / sevenths:   classical {scores['classic']['root']:.0f} / {scores['classic']['majmin']:.0f} / {scores['classic']['sevenths']:.0f}"
             f"   neural {scores['neural']['root']:.0f} / {scores['neural']['majmin']:.0f} / {scores['neural']['sevenths']:.0f}   (green = same major/minor chord as your tab, amber = same root, red = different)", fontsize=10)
slug = "".join(c if c.isalnum() else "-" for c in entry["name"].lower()).strip("-")
png = OUT / f"neural-demo-{slug}.png"; fig.savefig(png, dpi=120)

# audio: the song on the left, the neural chords as an organ on the right
INT = {"maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "min7": (0, 3, 7, 10), "sus2": (0, 2, 7), "sus4": (0, 5, 7), "dim": (0, 3, 6), "aug": (0, 4, 8), "6": (0, 4, 7, 9)}
SR = 22050
y = processor._sum_audio_files(stems)
n = int(window * SR); first = int(t0 * SR)
song = y[first:first + n]
chords = np.zeros(len(song))
for seg in segs["neural"]:
    a, b = max(seg["start"], t0), min(seg["end"], t1)
    if b <= a: continue
    root, q = seg["chord"].split(":"); r = NAMES.index(root)
    notes = [36 + (NAMES.index(seg["bass"]) if seg.get("bass") else r)] + [60 + (r + i) % 12 for i in INT[q]]
    tt = np.arange(int((b - a) * SR)) / SR
    body = sum(sum(amp * np.sin(2 * np.pi * 440 * 2 ** ((m - 69 + tune_cents / 100) / 12) * k * tt) for k, amp in ((1, 1), (2, .5), (3, .25))) for m in notes) / len(notes)
    fade = min(int(0.03 * SR), len(body) // 2)
    if fade: ramp = np.linspace(0, 1, fade); body[:fade] *= ramp; body[-fade:] *= ramp[::-1]
    i0 = int((a - t0) * SR); chords[i0:i0 + len(body)] += body[: len(chords) - i0]
song = song / (np.abs(song).max() + 1e-9) * 0.8; chords = chords / (np.abs(chords).max() + 1e-9) * 0.8
wav = OUT / f"neural-demo-{slug}.wav"; sf.write(wav, np.stack([song, chords], axis=1), SR)
print(json.dumps({"png": str(png), "wav": str(wav), "scores": scores, "offset": offset}))
