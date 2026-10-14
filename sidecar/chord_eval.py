"""
Score detected chords against a reference chart.

A developer tool, not part of the app: it answers "is this change to the
chord detector better or worse?" with a number instead of an impression.

    python chord_eval.py --song-dir <library/song> --ref chart.lab
    python chord_eval.py --manifest songs.json --detect --set _SWITCH_COST=0.2

The score is weighted chord symbol recall (the MIREX measure): the share of
the reference chart's time in which the detected chord equals the reference
chord, compared at three vocabularies (root, major/minor, sevenths). Time the
reference marks as a chord the vocabulary cannot express (a sus chord at the
major/minor level) is left out of the denominator, as in MIREX.

Reference charts are `.lab` files: one "start end label" line per segment,
labels either Harte ("C:maj7", "Bb:min", "N") or plain ("Am7", "F#", "C/E").
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path

LEVELS = ("root", "majmin", "sevenths")

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
_NO_CHORD = "N"

# Quality -> the triad it implies. Qualities missing here (sus, dim, aug, power
# chords) have no major/minor reading and are left out of that level.
_TRIAD = {
    "": "maj", "maj": "maj", "6": "maj", "maj6": "maj", "add9": "maj", "7": "maj",
    "9": "maj", "11": "maj", "13": "maj", "maj7": "maj", "maj9": "maj",
    "min": "min", "m": "min", "min6": "min", "min7": "min", "m7": "min",
    "min9": "min", "minmaj7": "min",
}

# Quality -> the four-note family it belongs to at the sevenths level.
_SEVENTH = {
    "": "maj", "maj": "maj", "6": "maj", "maj6": "maj", "add9": "maj",
    "7": "7", "9": "7", "11": "7", "13": "7",
    "maj7": "maj7", "maj9": "maj7",
    "min": "min", "m": "min", "min6": "min",
    "min7": "min7", "m7": "min7", "min9": "min7",
}

_PLAIN = re.compile(r"^([A-G])([#b]*)(.*)$")


def parse_label(label: str):
    """(root pitch class, quality) of a chord label, or None for "no chord"."""
    label = label.strip().split("/")[0]
    if label in ("N", "X", "", "*"):
        return None
    if ":" in label:
        root, quality = label.split(":", 1)
        quality = quality.split("(")[0]
    else:
        m = _PLAIN.match(label)
        if not m:
            raise ValueError(f"Unreadable chord label: {label!r}")
        root, quality = m.group(1) + m.group(2), m.group(3)
    letter = root[:1]
    if letter not in _LETTER_PC:
        raise ValueError(f"Unreadable chord root: {label!r}")
    pc = _LETTER_PC[letter]
    for accidental in root[1:]:
        pc += 1 if accidental == "#" else -1 if accidental == "b" else 0
    return pc % 12, quality


def simplify(label: str, level: str):
    """The label reduced to `level`: _NO_CHORD, a name, or None when it cannot be expressed there."""
    parsed = parse_label(label)
    if parsed is None:
        return _NO_CHORD
    pc, quality = parsed
    name = _NOTE_NAMES[pc]
    if level == "root":
        return name
    family = (_TRIAD if level == "majmin" else _SEVENTH).get(quality)
    return None if family is None else f"{name}:{family}"


def read_lab(path) -> list:
    segments = []
    for n, line in enumerate(Path(path).read_text(encoding="utf-8").splitlines(), 1):
        parts = line.split()
        if not parts or parts[0].startswith("#"):
            continue
        if len(parts) < 3:
            raise ValueError(f"{path}:{n}: expected 'start end label', got {line!r}")
        segments.append({"start": float(parts[0]), "end": float(parts[1]), "chord": " ".join(parts[2:])})
    return segments


def read_chords_json(path) -> list:
    return json.loads(Path(path).read_text(encoding="utf-8"))["segments"]


def _timeline(segments: list, level: str) -> list:
    """(start, end, simplified label) with gaps filled as no-chord, sorted."""
    out, cursor = [], 0.0
    for seg in sorted(segments, key=lambda s: s["start"]):
        if seg["start"] > cursor:
            out.append((cursor, seg["start"], _NO_CHORD))
        out.append((seg["start"], seg["end"], simplify(seg["chord"], level)))
        cursor = max(cursor, seg["end"])
    return out


def score(reference: list, estimate: list, level: str, duration: float | None = None) -> dict:
    """
    Weighted chord symbol recall of `estimate` against `reference` at `level`.
    `duration` caps the scored span (default: the end of the reference).
    """
    if level not in LEVELS:
        raise ValueError(f"Unknown level {level!r}")
    ref = _timeline(reference, level)
    est = _timeline(estimate, level)
    end = duration if duration is not None else (ref[-1][1] if ref else 0.0)
    est_end = est[-1][1] if est else 0.0
    if est_end < end:
        est.append((est_end, end, _NO_CHORD))

    hit = scored = 0.0
    confusions = Counter()
    j = 0
    for r_start, r_end, r_label in ref:
        r_end = min(r_end, end)
        if r_label is None or r_end <= r_start:
            continue
        t = r_start
        while j > 0 and est[j][0] > t:
            j -= 1
        while t < r_end:
            while j < len(est) and est[j][1] <= t:
                j += 1
            if j >= len(est):
                span, e_label = r_end - t, _NO_CHORD
            else:
                span = min(r_end, est[j][1]) - t
                e_label = est[j][2] if est[j][0] <= t else _NO_CHORD
                if est[j][0] > t:
                    span = min(span, est[j][0] - t)
            scored += span
            if e_label == r_label:
                hit += span
            else:
                confusions[(r_label, e_label if e_label is not None else "?")] += span
            t += span
    return {
        "level": level,
        "score": hit / scored if scored else 0.0,
        "scored_seconds": scored,
        "confusions": confusions.most_common(10),
    }


def shift(segments: list, offset: float) -> list:
    """The segments `offset` seconds later (earlier when negative), clipped at 0."""
    out = []
    for seg in segments:
        start, end = seg["start"] + offset, seg["end"] + offset
        if end > 0:
            out.append({**seg, "start": max(0.0, start), "end": end})
    return out


def best_offset(reference: list, estimate: list, max_seconds: float = 10.0, step: float = 0.1) -> dict:
    """
    The constant shift of `estimate` (seconds, positive = later) that scores best
    at the root level, searched over +-`max_seconds`. A chart written for another
    master of the same recording is usually offset by its different lead-in;
    a score that stays low even there means the chart does not fit this audio.
    """
    count = int(round(max_seconds / step))
    best = (-1.0, 0.0)
    for i in range(-count, count + 1):
        offset = round(i * step, 6)
        value = score(reference, shift(estimate, offset), "root")["score"]
        if value > best[0] + 1e-9 or (abs(value - best[0]) <= 1e-9 and abs(offset) < abs(best[1])):
            best = (value, offset)
    return {"offset": best[1], "root_score": best[0]}


def evaluate(reference: list, estimate: list, duration: float | None = None) -> dict:
    per_level = {level: score(reference, estimate, level, duration) for level in LEVELS}
    return {
        "levels": per_level,
        "reference_segments": len(reference),
        "estimated_segments": len(estimate),
    }


def _stem_paths(song_dir: Path) -> tuple:
    stems = {p.stem: str(p) for p in song_dir.glob("*.wav") if p.stem != "source"}
    source = song_dir / "source.wav"
    return stems, str(source) if source.exists() else None


def detect(song_dir, overrides: dict | None = None) -> tuple:
    """Run the chord detector on a song folder's stems, in memory (nothing is written)."""
    import processor

    for name, value in (overrides or {}).items():
        if not hasattr(processor, name):
            raise KeyError(f"processor has no constant {name}")
        setattr(processor, name, value)
    stems, source = _stem_paths(Path(song_dir))
    if not stems and not source:
        raise FileNotFoundError(f"No audio in {song_dir}")
    segments, duration = processor._detect_chords(stems, source)
    return segments, duration


def _parse_overrides(pairs: list) -> dict:
    out = {}
    for pair in pairs:
        name, _, value = pair.partition("=")
        if not value:
            raise ValueError(f"--set expects NAME=VALUE, got {pair!r}")
        out[name] = float(value)
    return out


def _entries(args) -> list:
    if args.manifest:
        base = Path(args.manifest).parent
        entries = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
        return [
            {"name": e.get("name") or Path(e["song_dir"]).name,
             "song_dir": str((base / e["song_dir"]).resolve()),
             "ref": str((base / e["ref"]).resolve())}
            for e in entries
        ]
    if not (args.song_dir and args.ref):
        raise SystemExit("Give --manifest, or --song-dir together with --ref")
    return [{"name": Path(args.song_dir).name, "song_dir": args.song_dir, "ref": args.ref}]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--manifest", help='JSON list of {"name", "song_dir", "ref"}; paths relative to the manifest')
    ap.add_argument("--song-dir")
    ap.add_argument("--ref", help="reference chart (.lab)")
    ap.add_argument("--detect", action="store_true", help="run the detector on the stems instead of reading chords.json")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE",
                    help="override a processor constant for this run (implies --detect)")
    ap.add_argument("--align", action="store_true",
                    help="also search a constant time offset between chart and detection and score at it")
    ap.add_argument("--json", help="also write the results to this file")
    args = ap.parse_args(argv)

    overrides = _parse_overrides(args.set)
    run_detector = args.detect or bool(overrides)
    results = []
    for entry in _entries(args):
        ref = read_lab(entry["ref"])
        if run_detector:
            est, duration = detect(entry["song_dir"], overrides)
        else:
            est = read_chords_json(Path(entry["song_dir"]) / "chords.json")
            duration = None
        result = evaluate(ref, est, duration)
        if args.align:
            found = best_offset(ref, est)
            result["offset"] = found["offset"]
            result["aligned"] = evaluate(ref, shift(est, found["offset"]), duration)
        result["name"] = entry["name"]
        results.append(result)

    aligned = args.align
    head = f"{'song':<40}" + "".join(f"{level:>10}" for level in LEVELS) + f"{'segs ref/est':>16}"
    print(head + (f"{'offset s':>10}" + "".join(f"{'@' + level:>11}" for level in LEVELS) if aligned else ""))
    for r in results:
        cells = "".join(f"{r['levels'][level]['score'] * 100:>9.1f}%" for level in LEVELS)
        line = f"{r['name'][:39]:<40}{cells}{r['reference_segments']:>9}/{r['estimated_segments']:<6}"
        if aligned:
            line += f"{r['offset']:>+10.1f}" + "".join(f"{r['aligned']['levels'][level]['score'] * 100:>10.1f}%" for level in LEVELS)
        print(line)
    if len(results) > 1:
        def overall(pick) -> str:
            cells = ""
            for level in LEVELS:
                total = sum(pick(r)["levels"][level]["scored_seconds"] for r in results)
                hit = sum(pick(r)["levels"][level]["score"] * pick(r)["levels"][level]["scored_seconds"] for r in results)
                cells += f"{hit / total * 100 if total else 0:>9.1f}%"
            return cells

        line = f"{'ALL (time-weighted)':<40}{overall(lambda r: r)}"
        if aligned:
            line += f"{'':>31}{overall(lambda r: r['aligned'])}"
        print(line)
    for r in results:
        print(f"\n{r['name']}: most common mistakes at the sevenths level (reference -> detected, seconds)")
        for (want, got), seconds in r["levels"]["sevenths"]["confusions"]:
            print(f"  {want:>8} -> {got:<8} {seconds:7.1f}")
    if args.json:
        Path(args.json).write_text(json.dumps(results, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
