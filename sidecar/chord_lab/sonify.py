"""
Hear the chords against the song.

    python chord_lab\\sonify.py isophonics "let it be"
    python chord_lab\\sonify.py tabs mercy --chords reference --start 60 --end 90
    python chord_lab\\sonify.py isophonics help --layout blend

Writes results/<song>-<detected|reference>-<layout>.wav. The default layout puts
the song in the left channel and an organ-like rendering of the chords in the
right one: pan between them and a wrong chord is audible as a clash. `blend`
mixes both into one mono file instead, closer to how the app's Hear/With song
sounds. Chords are voiced from the stored chord alone (root and slash bass low,
the other tones above) and detuned by the measured tuning, as the app does.
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab

import numpy as np
import soundfile as sf

import chord_eval
import processor

SR = processor.SAMPLE_RATE
FADE = 0.03
TONES = {
    "maj": (0, 4, 7), "min": (0, 3, 7), "7": (0, 4, 7, 10), "maj7": (0, 4, 7, 11), "min7": (0, 3, 7, 10),
}


def voicing(chord: str, bass: str | None) -> list:
    """MIDI notes of a chord: root (or slash bass) in the bass octave, the chord tones above middle C."""
    parsed = chord_eval.parse_label(chord)
    if parsed is None:
        return []
    family = chord_eval.simplify(chord, "sevenths")
    if family in (None, "N"):
        return []
    root = parsed[0]
    quality = family.split(":", 1)[1]
    bass_pc = processor.NOTE_NAMES.index(bass) if bass else root
    notes = [36 + bass_pc]
    notes += [60 + (root + offset) % 12 for offset in TONES[quality]]
    return notes


def tone(midi: int, seconds: float, tuning_cents: float) -> np.ndarray:
    freq = 440.0 * 2 ** ((midi - 69 + tuning_cents / 100.0) / 12.0)
    t = np.arange(int(seconds * SR)) / SR
    return sum(amp * np.sin(2 * np.pi * freq * k * t) for k, amp in ((1, 1.0), (2, 0.5), (3, 0.25)))


def render(segments: list, length: float, tuning_cents: float) -> np.ndarray:
    out = np.zeros(int(length * SR))
    for seg in segments:
        start, end = max(0.0, seg["start"]), min(length, seg["end"])
        notes = voicing(seg["chord"], seg.get("bass"))
        if end <= start or not notes:
            continue
        body = sum(tone(m, end - start, tuning_cents) for m in notes) / len(notes)
        fade = min(int(FADE * SR), len(body) // 2)
        if fade:
            ramp = np.linspace(0.0, 1.0, fade)
            body[:fade] *= ramp
            body[-fade:] *= ramp[::-1]
        first = int(start * SR)
        out[first:first + len(body)] += body[: len(out) - first]
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("dataset")
    ap.add_argument("song", help="part of the song's name")
    ap.add_argument("--chords", choices=["detected", "reference"], default="detected")
    ap.add_argument("--layout", choices=["split", "blend"], default="split")
    ap.add_argument("--const", action="append", default=[], metavar="NAME=VALUE")
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--end", type=float, default=None, help="default: the end of the song")
    args = ap.parse_args(argv)

    dataset = lab.load_set(args.dataset)
    entry = lab.find_song(dataset, args.song)
    prep_values, run_values = lab.split_constants(lab.parse_constants(args.const))

    print(f"Reading {entry['name']} ...", file=sys.stderr)
    prepared = lab.prepare(entry["song_dir"], **prep_values)
    detected = lab.detect(prepared, **run_values)
    reference, _ = lab.aligned_reference(entry, detected, dataset.align)
    segments = detected if args.chords == "detected" else reference

    source = Path(entry["song_dir"]) / "source.wav"
    song = None
    if source.exists():
        import librosa
        song, _ = librosa.load(source, sr=SR, mono=True)
    if song is None:
        song = prepared.mix
    length = len(song) / SR
    chords = render(segments, length, prepared.tuning * 100)

    first, last = int(args.start * SR), int((args.end if args.end else length) * SR)
    song, chords = song[first:last], chords[first:last]
    song = song / (np.abs(song).max() + 1e-9) * 0.8
    chords = chords / (np.abs(chords).max() + 1e-9) * 0.8
    if args.layout == "split":
        audio = np.stack([song, chords], axis=1)
    else:
        audio = (0.65 * song + 0.35 * chords)[:, None]
        audio = audio / (np.abs(audio).max() + 1e-9) * 0.9

    lab.RESULTS.mkdir(exist_ok=True)
    out = lab.RESULTS / f"{Path(entry['song_dir']).name}-{args.chords}-{args.layout}.wav"
    sf.write(out, audio, SR)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
