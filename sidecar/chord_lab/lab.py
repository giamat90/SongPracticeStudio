"""
Shared pieces of the chord lab: where things live, how a data set is read, and
the production chord detector run from inputs that are decoded once.

`prepare` mirrors `processor._detect_chords_full` up to the point where the
signal is handed to `processor._chords_from_signal`; `tests/test_chord_lab.py`
holds the two to the same answer, so a sweep over a decoding-free constant does
not have to decode the song again for every value.
"""

import json
import sys
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

LAB = Path(__file__).resolve().parent
SIDECAR = LAB.parent
DATASETS = LAB / "datasets"
RESULTS = LAB / "results"

if str(SIDECAR) not in sys.path:
    sys.path.insert(0, str(SIDECAR))

import librosa
import numpy as np

import chord_eval
import processor

LEVELS = chord_eval.LEVELS

# Constants read while the audio is prepared (which stems, where the beats are),
# not while it is decoded into chords: changing one means preparing again.
PREPARE_CONSTANTS = frozenset({
    "_CHORD_EXCLUDED_STEMS", "_CHORD_HARMONY_STEMS", "_MIN_BEATS", "_BEAT_INTERVAL_RANGE", "_CHORD_HOP_LENGTH",
})


def parse_constants(pairs: list) -> dict:
    """["NAME=VALUE", ...] -> {name: number}; the names must exist in `processor`."""
    out = {}
    for pair in pairs or []:
        name, _, value = pair.partition("=")
        if not value:
            raise ValueError(f"expected NAME=VALUE, got {pair!r}")
        out[name] = _number(value)
    _check_names(out)
    return out


def _number(text: str):
    try:
        return int(text)
    except ValueError:
        return float(text)


def _check_names(constants: dict) -> None:
    for name in constants:
        if not hasattr(processor, name):
            raise KeyError(f"processor has no constant {name}")


@contextmanager
def constants(**values):
    """Set `processor` constants for the duration of the block and put the old ones back."""
    _check_names(values)
    saved = {name: getattr(processor, name) for name in values}
    try:
        for name, value in values.items():
            setattr(processor, name, value)
        yield
    finally:
        for name, value in saved.items():
            setattr(processor, name, value)


def available_sets() -> list:
    return sorted(p.parent.name for p in DATASETS.glob("*/manifest.json"))


@dataclass
class Dataset:
    name: str
    description: str
    align: bool
    songs: list


def load_set(name: str) -> Dataset:
    """
    datasets/<name>/manifest.json: {"description", "align", "songs": [{"name",
    "song_dir", "ref", ...}]}, paths relative to the manifest. `align` says the
    chart was written for another master of the recording, so a constant
    offset has to be found before the two are compared.
    """
    path = DATASETS / name / "manifest.json"
    if not path.exists():
        raise SystemExit(f"No data set {name!r}. Available: {', '.join(available_sets()) or 'none (see README: Data sets)'}")
    raw = json.loads(path.read_text(encoding="utf-8"))
    songs = []
    for entry in raw["songs"]:
        songs.append({
            **entry,
            "name": entry.get("name") or Path(entry["song_dir"]).name,
            "song_dir": str((path.parent / Path(entry["song_dir"]).expanduser()).resolve()),
            "ref": str((path.parent / Path(entry["ref"]).expanduser()).resolve()),
        })
    return Dataset(name, raw.get("description", ""), bool(raw.get("align", False)), songs)


@dataclass
class Prepared:
    mix: np.ndarray
    bass_y: object
    beats: object
    tuning: float
    duration: float
    sources: list


def prepare(song_dir, **overrides) -> Prepared:
    """What the detector reads from a song folder, decoded once (nothing is written)."""
    with constants(**overrides):
        stems, source = chord_eval._stem_paths(Path(song_dir))
        if not stems and not source:
            raise FileNotFoundError(f"No audio in {song_dir}")
        sources = processor._harmonic_stem_paths(stems)
        if sources is None:
            sources = {"mix": source} if source else stems
        mix = processor._sum_audio_files(sources)
        bass_y = None
        if "bass" in stems:
            bass_y, _ = librosa.load(stems["bass"], sr=processor.SAMPLE_RATE, mono=True)
        beats = processor._beat_frames(stems if stems else sources)
        tuning = float(librosa.estimate_tuning(y=mix, sr=processor.SAMPLE_RATE))
    return Prepared(mix, bass_y, beats, tuning, len(mix) / processor.SAMPLE_RATE, list(sources))


def detect(prepared: Prepared, **overrides) -> list:
    """The production detector on prepared audio, with `processor` constants overridden for the run."""
    with constants(**overrides):
        return processor._chords_from_signal(
            prepared.mix, processor.SAMPLE_RATE, prepared.bass_y,
            beat_frames=prepared.beats, tuning=prepared.tuning,
        )


def split_constants(values: dict) -> tuple:
    """(constants that change what is prepared, constants that change the decoding)."""
    prep = {k: v for k, v in values.items() if k in PREPARE_CONSTANTS}
    return prep, {k: v for k, v in values.items() if k not in PREPARE_CONSTANTS}


def score_song(entry: dict, values: dict, align: bool, prepared: Prepared | None = None) -> dict:
    """
    Evaluate the detector against one song's chart. Returns the chord_eval result
    (at the best constant offset when `align`), the offset and the detected segments.
    """
    prep_values, run_values = split_constants(values)
    if prepared is None:
        prepared = prepare(entry["song_dir"], **prep_values)
    estimate = detect(prepared, **run_values)
    reference = chord_eval.read_lab(entry["ref"])
    offset = chord_eval.best_offset(reference, estimate)["offset"] if align else 0.0
    shifted = chord_eval.shift(estimate, offset) if offset else estimate
    result = chord_eval.evaluate(reference, shifted, prepared.duration)
    result.update(name=entry["name"], offset=offset, segments=estimate)
    return result


def weighted(results: list, level: str) -> float:
    """Time-weighted score over songs at one level."""
    total = sum(r["levels"][level]["scored_seconds"] for r in results)
    hit = sum(r["levels"][level]["score"] * r["levels"][level]["scored_seconds"] for r in results)
    return hit / total if total else 0.0


def bootstrap(results: list, level: str, rounds: int = 2000, seed: int = 0) -> tuple:
    """95% interval of the time-weighted score when the songs are resampled with replacement."""
    scores = np.array([r["levels"][level]["score"] for r in results])
    seconds = np.array([r["levels"][level]["scored_seconds"] for r in results])
    if len(results) < 2 or seconds.sum() == 0:
        value = weighted(results, level)
        return value, value
    rng = np.random.default_rng(seed)
    picks = rng.integers(0, len(results), size=(rounds, len(results)))
    totals = seconds[picks].sum(axis=1)
    means = np.divide((scores[picks] * seconds[picks]).sum(axis=1), totals, out=np.zeros(rounds), where=totals > 0)
    return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))


def chord_at(segments: list, t: float):
    """The segment sounding at time `t`, or None."""
    for seg in segments:
        if seg["start"] <= t < seg["end"]:
            return seg
    return None


def aligned_reference(entry: dict, estimate: list, align: bool) -> tuple:
    """(reference segments moved onto the audio, offset). The detector's segments stay where they are."""
    reference = chord_eval.read_lab(entry["ref"])
    if not align:
        return reference, 0.0
    offset = chord_eval.best_offset(reference, estimate)["offset"]
    return chord_eval.shift(reference, -offset), offset


def find_song(dataset: Dataset, query: str) -> dict:
    hits = [s for s in dataset.songs if query.lower() in s["name"].lower() or query.lower() in Path(s["song_dir"]).name.lower()]
    if len(hits) != 1:
        names = ", ".join(s["name"] for s in dataset.songs)
        raise SystemExit(f"{len(hits)} songs match {query!r} in {dataset.name}. Songs: {names}")
    return hits[0]
