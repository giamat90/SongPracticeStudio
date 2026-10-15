"""
Reference chord charts from a tab, for scoring the chord detector.

A developer tool, like chord_eval.py: it is not part of the app.

    python tab_chords.py --midi tab.mid --song-dir <library/song> --out song.lab

The tab is read from the MIDI export of the same Guitar Pro file (repeats and
the tempo map are already played out in it), turned into the score that
tab_sync.align_tab_to_stems expects, placed on the song's stems with that
aligner, and the notes played in each beat are named as a chord. The result is
a Harte `.lab` chart that chord_eval.py scores the detector against.

What the chart is and is not: the labels come from the notes of the tab, not
from the audio, so they do not depend on the detector. They are an inference
(a riff is not a chord), so a beat that does not say enough, a lone note or
notes that fit no chord, is written as unknown ("X") and left out of the score,
and a bare fifth as a power chord ("E:5"), which chord_eval.py scores at the
root level only.
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import numpy as np

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

VOCAL_NAME = re.compile(r"vocal|vox|voice|choir|singer", re.I)


# ── MIDI ────────────────────────────────────────────────────────────────────

class MidiError(ValueError):
    pass


def _vlq(data: bytes, pos: int) -> tuple:
    value = 0
    while True:
        if pos >= len(data):
            raise MidiError("Truncated MIDI event")
        byte = data[pos]
        pos += 1
        value = (value << 7) | (byte & 0x7F)
        if not byte & 0x80:
            return value, pos


def read_midi(path) -> dict:
    """
    {"division", "tempos": [[tick, bpm]], "time_signatures": [[tick, num, den]],
     "end": last tick, "tracks": [{"name", "channels": {ch: program},
     "notes": [(tick, duration, pitch, channel)]}]}
    """
    data = Path(path).read_bytes()
    if data[:4] != b"MThd":
        raise MidiError("Not a MIDI file")
    ntracks = int.from_bytes(data[10:12], "big")
    division = int.from_bytes(data[12:14], "big")
    if division & 0x8000:
        raise MidiError("SMPTE time division is not supported")
    pos = 8 + int.from_bytes(data[4:8], "big")

    tempos, signatures, tracks, end = {}, {}, [], 0
    for _ in range(ntracks):
        if data[pos:pos + 4] != b"MTrk":
            raise MidiError("Bad MIDI track header")
        size = int.from_bytes(data[pos + 4:pos + 8], "big")
        body, pos = data[pos + 8:pos + 8 + size], pos + 8 + size

        name, channels, notes = "", {}, []
        open_notes, tick, status, i = {}, 0, 0, 0
        while i < len(body):
            delta, i = _vlq(body, i)
            tick += delta
            if body[i] & 0x80:
                status = body[i]
                i += 1
            if status == 0xFF:
                kind = body[i]
                length, i = _vlq(body, i + 1)
                payload = body[i:i + length]
                i += length
                if kind == 0x03 and not name:
                    name = payload.decode("latin1", "replace").strip()
                elif kind == 0x51 and length == 3:
                    tempos[tick] = 60_000_000 / int.from_bytes(payload, "big")
                elif kind == 0x58 and length >= 2:
                    signatures[tick] = (payload[0], 2 ** payload[1])
            elif status in (0xF0, 0xF7):
                length, i = _vlq(body, i)
                i += length
            else:
                kind, channel = status & 0xF0, status & 0x0F
                if kind in (0xC0, 0xD0):
                    arg = body[i]
                    i += 1
                    if kind == 0xC0:
                        channels.setdefault(channel, arg)
                else:
                    a, b = body[i], body[i + 1]
                    i += 2
                    if kind == 0x90 and b > 0:
                        open_notes.setdefault((channel, a), []).append(tick)
                    elif kind == 0x80 or (kind == 0x90 and b == 0):
                        stack = open_notes.get((channel, a))
                        if stack:
                            start = stack.pop(0)
                            notes.append((start, max(1, tick - start), a, channel))
        # The end of the music is its last note, not the end-of-track marker (which can sit a bar later).
        end = max(end, max((n[0] + n[1] for n in notes), default=0))
        tracks.append({"name": name, "channels": channels, "notes": notes})

    return {
        "division": division,
        "tempos": sorted([t, bpm] for t, bpm in tempos.items()),
        "time_signatures": sorted([t, n, d] for t, (n, d) in signatures.items()),
        "end": end,
        "tracks": tracks,
    }


def track_role(program, is_percussion: bool, name: str):
    """What a track contributes, by General MIDI program (the rule the app's tab panel uses)."""
    if is_percussion:
        return "d"
    if VOCAL_NAME.search(name):
        return None
    if program is None:
        return None
    if 24 <= program <= 31:
        return "g"
    if 32 <= program <= 39:
        return "b"
    if 0 <= program <= 23:
        return "k"
    return None


def bars_from_signatures(midi: dict) -> list:
    """Bar lines in played order from the time signatures (a bar's length is its signature)."""
    division, end = midi["division"], midi["end"]
    sigs = midi["time_signatures"] or [[0, 4, 4]]
    if sigs[0][0] > 0:
        sigs = [[0, sigs[0][1], sigs[0][2]]] + sigs
    bars, tick, k = [], 0, 0
    while tick < end or not bars:
        while k + 1 < len(sigs) and sigs[k + 1][0] <= tick:
            k += 1
        _, num, den = sigs[k]
        length = division * 4 * num // den
        if length <= 0:
            raise MidiError("A bar with no length")
        bars.append({"tick": tick, "end": tick + length, "index": len(bars), "occurrence": 0})
        tick += length
    return bars


def score_from_midi(midi: dict) -> dict:
    """The sidecar's tab score: played bars, tempo map and [tick, duration, pitch, role] notes."""
    notes = []
    for track in midi["tracks"]:
        for start, duration, pitch, channel in track["notes"]:
            role = track_role(track["channels"].get(channel), channel == 9, track["name"])
            if role:
                notes.append([start, duration, pitch, role])
    tempos = midi["tempos"] or [[0, 120.0]]
    return {
        "version": 1,
        "division": midi["division"],
        "tempos": tempos,
        "bars": bars_from_signatures(midi),
        "notes": notes,
    }


# ── naming the chords ───────────────────────────────────────────────────────

TEMPLATES = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "min7": (0, 3, 7, 10),
    "sus2": (0, 2, 7),
    "sus4": (0, 5, 7),
}
SEVENTH_SHARE = 0.12
# A chord needs most of the sounding notes to belong to it: a triad among four
# equal notes scores 0.87, among five 0.77, among a six-note run 0.71.
MIN_FIT = 0.75
SWITCH_COST = 0.15
MIN_WEIGHT = 1e-6


def _vector(tones) -> np.ndarray:
    v = np.zeros(12)
    for t in tones:
        v[t % 12] = 1.0
    return v / np.linalg.norm(v)


_CANDIDATES = [(root, quality, _vector([(root + i) for i in iv]))
               for root in range(12) for quality, iv in TEMPLATES.items()]


def window_label(weights: np.ndarray, bass_pc) -> tuple:
    """
    (label, fit) for one beat's pitch-class weights. Conservative on purpose: a
    seventh needs its note to carry a real share, a window with fewer than two
    pitch classes is not a chord, and a bare fifth is a power chord.
    """
    total = float(weights.sum())
    if total <= MIN_WEIGHT:
        return "N", 1.0
    share = weights / total
    present = [pc for pc in range(12) if share[pc] >= 0.08]
    if len(present) < 2:
        # One note is a note, not a chord: against the chord names authors write
        # into tabs, a lone note named the chord's root only a quarter of the time.
        return "X", 0.0
    if len(present) == 2:
        a, b = present
        for root, other in ((a, b), (b, a)):
            if (other - root) % 12 == 7:
                return f"{NOTE_NAMES[root]}:5", 0.8
        return "X", 0.0

    unit = weights / np.linalg.norm(weights)
    best, best_fit = None, -1.0
    for root, quality, vec in _CANDIDATES:
        fit = float(vec @ unit)
        if bass_pc is not None and root == bass_pc:
            fit += 0.06
        if quality in ("7", "maj7", "min7"):
            seventh = (root + (11 if quality == "maj7" else 10)) % 12
            if share[seventh] < SEVENTH_SHARE:
                continue
        if fit > best_fit:
            best, best_fit = (root, quality), fit
    if best is None or best_fit < MIN_FIT:
        return "X", best_fit
    return f"{NOTE_NAMES[best[0]]}:{best[1]}", best_fit


def _smooth(labels: list, fits: list) -> list:
    """One-beat flips are decided by the audio's neighbours, not by one noisy beat: keep a change only if it holds."""
    out = list(labels)
    for i in range(1, len(out) - 1):
        if out[i - 1] == out[i + 1] and out[i] != out[i - 1] and fits[i] < 0.9:
            out[i] = out[i - 1]
    return out


def chords_from_score(score: dict, bar_times: list, shift: int = 0) -> list:
    """
    Chord segments ({"start", "end", "chord"}, seconds in the recording) from the
    notes the tab plays in each beat of each bar, placed by `bar_times` (one per
    played bar). `shift` is the aligner's semitone retune of the tab.
    """
    bars = score["bars"]
    division = score["division"]
    pitched = [n for n in score["notes"] if n[3] in ("g", "b", "k")]
    pitched.sort(key=lambda n: n[0])
    starts = np.array([n[0] for n in pitched], dtype=np.float64)

    windows = []
    for k, bar in enumerate(bars):
        length = bar["end"] - bar["tick"]
        beats = max(1, round(length / division))
        step = length / beats
        t0 = bar_times[k]
        t1 = bar_times[k + 1] if k + 1 < len(bars) else t0 + (t0 - bar_times[k - 1] if k else 2.0)
        for b in range(beats):
            windows.append((bar["tick"] + b * step, bar["tick"] + (b + 1) * step,
                            t0 + (t1 - t0) * b / beats, t0 + (t1 - t0) * (b + 1) / beats))

    labels, fits = [], []
    lo = 0
    for w0, w1, _, _ in windows:
        weights = np.zeros(12)
        low_pitch, low_pc = None, None
        i = int(np.searchsorted(starts, w0 - division * 8, side="left"))
        while i < len(pitched) and pitched[i][0] < w1:
            tick, duration, pitch, role = pitched[i]
            overlap = min(w1, tick + duration) - max(w0, tick)
            if overlap > 0:
                weights[pitch % 12] += overlap
                if role == "b" and (low_pitch is None or pitch < low_pitch):
                    low_pitch, low_pc = pitch, pitch % 12
            i += 1
        label, fit = window_label(weights, low_pc)
        labels.append(label)
        fits.append(fit)
    labels = _smooth(labels, fits)

    segments = []
    for (w0, w1, s0, s1), label in zip(windows, labels):
        chord = label
        if ":" in chord:
            root, quality = chord.split(":", 1)
            chord = f"{NOTE_NAMES[(NOTE_NAMES.index(root) + shift) % 12]}:{quality}"
        if segments and segments[-1]["chord"] == chord and abs(segments[-1]["end"] - s0) < 1e-6:
            segments[-1]["end"] = s1
        else:
            segments.append({"start": s0, "end": s1, "chord": chord})
    return segments


def write_lab(segments: list, path) -> None:
    Path(path).write_text(
        "".join(f"{s['start']:.3f} {s['end']:.3f} {s['chord']}\n" for s in segments), encoding="utf-8")


# ── command line ────────────────────────────────────────────────────────────

def stems_in(song_dir: Path) -> dict:
    return {p.stem: str(p) for p in song_dir.glob("*.wav") if p.stem in
            ("vocals", "drums", "bass", "guitar", "piano", "other")}


def build(midi_path, song_dir, lab_path=None) -> dict:
    """Align the tab to the song and write its chord chart; returns what to know about how far to trust it."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import tab_sync

    score = score_from_midi(read_midi(midi_path))
    stems = stems_in(Path(song_dir))
    if not stems:
        raise FileNotFoundError(f"No stems in {song_dir}")
    aligned = tab_sync.align_tab_to_stems(score, stems)
    times = [b["time"] for b in aligned["bars"]]
    segments = chords_from_score(score, times, aligned["transpose"])
    if lab_path:
        write_lab(segments, lab_path)
    kinds = {"chord": 0.0, "power": 0.0, "unknown": 0.0}
    for s in segments:
        d = s["end"] - s["start"]
        q = s["chord"].split(":")[-1]
        kinds["power" if q == "5" else "unknown" if s["chord"] in ("X", "N") else "chord"] += d
    total = sum(kinds.values()) or 1.0
    return {
        "quality": aligned["quality"],
        "transpose": aligned["transpose"],
        "offset": aligned["offset"],
        "steadiness": aligned["steadiness"],
        "bars": len(score["bars"]),
        "notes": len(score["notes"]),
        "share": {k: round(v / total, 3) for k, v in kinds.items()},
        "bar_times": times,
        "segments": segments,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--midi", required=True)
    ap.add_argument("--song-dir", required=True, help="a library song folder with its stems")
    ap.add_argument("--out", required=True, help="the .lab chart to write")
    args = ap.parse_args(argv)
    result = build(args.midi, args.song_dir, args.out)
    summary = {k: v for k, v in result.items() if k != "segments"}
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
