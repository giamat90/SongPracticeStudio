"""
See what the detector did on one song: the chroma it read, the chords it chose,
the reference chart, and where the two disagree.

    python chord_lab\\visualize.py isophonics "let it be"
    python chord_lab\\visualize.py tabs mercy --start 60 --window 40 --save
    python chord_lab\\visualize.py isophonics help --const _SEVENTH_MARGIN=0.02

Rows, top to bottom: chroma (energy per pitch class, tuned to the recording),
the detected chords (paler = less confident), the reference chords, and a strip
that is green where the major/minor chord agrees, amber where only the root
does, red where neither. Slider or arrow keys (left/right 1 s, up/down one
window) move through the song; --save writes results/<song>-chords-<t>s.png.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab

import librosa
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.widgets import Slider

import chord_eval
import processor

STRIP_STEP = 0.1
GREEN, AMBER, RED, GREY = "#3a9d5d", "#d9a21b", "#c0392b", "#555555"


def agreement(detected: list, reference: list, times: np.ndarray) -> np.ndarray:
    """0 = no chord in the reference, 1 = agree at major/minor, 2 = same root only, 3 = different."""
    out = np.zeros(len(times), dtype=int)
    for i, t in enumerate(times):
        ref, det = lab.chord_at(reference, t), lab.chord_at(detected, t)
        want = chord_eval.simplify(ref["chord"], "majmin") if ref else None
        if want in (None, "N"):
            continue
        got = chord_eval.simplify(det["chord"], "majmin") if det else None
        if got == want:
            out[i] = 1
        elif det and chord_eval.simplify(det["chord"], "root") == chord_eval.simplify(ref["chord"], "root"):
            out[i] = 2
        else:
            out[i] = 3
    return out


def draw_chords(ax, segments: list, t0: float, t1: float, confidence: bool) -> None:
    ax.set_xlim(t0, t1)
    ax.set_ylim(0, 1)
    ax.set_yticks([])
    for seg in segments:
        if seg["end"] < t0 or seg["start"] > t1:
            continue
        shade = 0.25 + 0.75 * min(1.0, max(0.0, (seg.get("confidence", 1.0) - 0.5) / 0.4)) if confidence else 0.75
        ax.axvspan(seg["start"], seg["end"], color=plt.cm.tab20c(0.04 + (root_of(seg["chord"]) / 12) * 0.9), alpha=shade, lw=0)
        ax.axvline(seg["start"], color="black", lw=0.6)
        middle = (max(seg["start"], t0) + min(seg["end"], t1)) / 2
        label = seg["chord"].replace(":maj", "").replace(":min", "m")
        if seg.get("bass"):
            label += "/" + seg["bass"]
        if seg["end"] - seg["start"] >= (t1 - t0) / 60:
            ax.text(middle, 0.5, label, ha="center", va="center", fontsize=9)


def root_of(label: str) -> int:
    parsed = chord_eval.parse_label(label)
    return 0 if parsed is None else parsed[0]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dataset")
    ap.add_argument("song", help="part of the song's name")
    ap.add_argument("--const", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--start", type=float, default=0.0, help="window start, seconds")
    ap.add_argument("--window", type=float, default=30.0, help="seconds shown at once")
    ap.add_argument("--save", action="store_true", help="write a PNG instead of opening a window")
    args = ap.parse_args(argv)

    dataset = lab.load_set(args.dataset)
    entry = lab.find_song(dataset, args.song)
    values = lab.parse_constants(args.const)
    prep_values, run_values = lab.split_constants(values)

    print(f"Reading {entry['name']} ...", file=sys.stderr)
    prepared = lab.prepare(entry["song_dir"], **prep_values)
    detected = lab.detect(prepared, **run_values)
    reference, offset = lab.aligned_reference(entry, detected, dataset.align)
    chroma = librosa.feature.chroma_cqt(
        y=prepared.mix, sr=processor.SAMPLE_RATE, hop_length=processor._CHORD_HOP_LENGTH, tuning=prepared.tuning)
    frame_dur = processor._CHORD_HOP_LENGTH / processor.SAMPLE_RATE
    tuning_cents = prepared.tuning * 100
    chroma = chroma / (chroma.max(axis=0, keepdims=True) + 1e-9)

    figure, (ax_chroma, ax_det, ax_ref, ax_cmp) = plt.subplots(
        4, 1, figsize=(15, 6.5), sharex=True, gridspec_kw={"height_ratios": [4, 1.2, 1.2, 0.5]})
    figure.subplots_adjust(left=0.05, right=0.99, top=0.9, bottom=0.14, hspace=0.08)
    window = args.window

    def render(t0: float) -> None:
        t1 = t0 + window
        for ax in (ax_chroma, ax_det, ax_ref, ax_cmp):
            ax.clear()
        i0, i1 = int(t0 / frame_dur), int(t1 / frame_dur)
        ax_chroma.imshow(chroma[:, i0:i1], aspect="auto", origin="lower", cmap="magma", vmin=0, vmax=1,
                         extent=[t0, min(t1, chroma.shape[1] * frame_dur), -0.5, 11.5])
        ax_chroma.set_yticks(range(12))
        ax_chroma.set_yticklabels(processor.NOTE_NAMES, fontsize=8)
        ax_chroma.set_xlim(t0, t1)
        draw_chords(ax_det, detected, t0, t1, confidence=True)
        draw_chords(ax_ref, reference, t0, t1, confidence=False)
        ax_det.set_ylabel("detected", rotation=0, ha="right", va="center", fontsize=9)
        ax_ref.set_ylabel("reference", rotation=0, ha="right", va="center", fontsize=9)
        times = np.arange(t0, t1, STRIP_STEP)
        classes = agreement(detected, reference, times)
        colours = [GREY, GREEN, AMBER, RED]
        for t, c in zip(times, classes):
            if c:
                ax_cmp.axvspan(t, t + STRIP_STEP, color=colours[c], lw=0)
        ax_cmp.set_xlim(t0, t1)
        ax_cmp.set_yticks([])
        ax_cmp.set_xlabel("seconds")
        shown = classes[classes > 0]
        agree = float((shown == 1).mean() * 100) if len(shown) else 0.0
        figure.suptitle(
            f"{entry['name']}  |  {t0:.0f}-{t1:.0f} s  |  major/minor agreement here {agree:.0f}%  |  "
            f"tuning {tuning_cents:+.0f} cents  |  reference moved {-offset:+.1f} s"
            + (f"  |  {', '.join(f'{k}={v:g}' for k, v in values.items())}" if values else ""),
            fontsize=10)
        figure.canvas.draw_idle()

    last = max(0.0, prepared.duration - window)
    start = min(max(0.0, args.start), last)
    if args.save:
        render(start)
        lab.RESULTS.mkdir(exist_ok=True)
        out = lab.RESULTS / f"{Path(entry['song_dir']).name}-chords-{int(start)}s.png"
        figure.savefig(out, dpi=130)
        print(f"wrote {out}")
        return 0

    slider = Slider(figure.add_axes([0.1, 0.03, 0.8, 0.03]), "start (s)", 0.0, max(last, 1.0), valinit=start)
    slider.on_changed(lambda v: render(v))

    def on_key(event) -> None:
        step = {"left": -1.0, "right": 1.0, "up": window, "down": -window}.get(event.key)
        if step is not None:
            slider.set_val(min(max(0.0, slider.val + step), last))

    figure.canvas.mpl_connect("key_press_event", on_key)
    render(start)
    plt.show()
    return 0


if __name__ == "__main__":
    sys.exit(main())
