"""
Bar finding: where the bars of a song start and how many beats each has.

The song's beats are tracked on the drums and bass; each beat is then described by how hard the kick, the snare, the
bass and the harmony hit on it. A bar length of N beats is right when one position in every N stands out; the one
that does is the downbeat. The bars are the tracked beats cut into groups of N from that position, so a song that
speeds up or slows down keeps its bar lines on the beat.

This is the first guess the Meter panel offers and not the last word: one meter for the whole song, no changes of
signature, and a confidence that says how plainly the accents stood out. The panel's tools are for correcting it.
Measured against Guitar Pro tabs in `meter_lab/` (see wiki/meter-detection.md).
"""

import json
import os
import sys
import traceback

import librosa
import numpy as np

ALGORITHM = "stems-accent-v0"
FORMAT_VERSION = 1
SAMPLE_RATE = 22050
HOP = 512

# Bar lengths in beats worth trying. 8 and up are two bars, which every four-beat song would look like.
CANDIDATES = (2, 3, 4, 5, 6, 7)
MIN_BEATS = 16
# A beat period outside this is not a pulse a person counts bars in (same range as the chord windows).
BEAT_PERIOD_RANGE = (0.2, 1.5)
# Below this a beat is counted in eighths (x/8), above in quarters (x/4).
EIGHTH_PERIOD = 0.33
# How far a bar length must lead the runner-up, and how clearly it must stand out, to be fully trusted.
MARGIN_FULL = 0.08
STRENGTH_FULL = 0.06
KICK_BINS = 12


def _log(msg: str) -> None:
    print(f"[meter] {msg}", file=sys.stderr, flush=True)


def _load(paths: list) -> np.ndarray | None:
    mix = None
    for path in paths:
        y, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
        if mix is None:
            mix = y.copy()
        else:
            n = max(len(mix), len(y))
            mix = np.pad(mix, (0, n - len(mix)))
            mix[: len(y)] += y
    return mix


def _sync(feature: np.ndarray, beats: np.ndarray, how=np.mean, centred: bool = False) -> np.ndarray:
    """
    One value per beat from the frames around it. `centred` takes the frames halfway to the neighbouring beats on each
    side, so a hit that lands a little before the tracked beat is still that beat's; otherwise the frames from the beat
    to the next one (right for a harmony that changes on the beat).
    """
    n = feature.shape[-1]
    beats = np.asarray(beats, dtype=float)
    if centred:
        mids = (beats[:-1] + beats[1:]) / 2
        edges = np.concatenate([[max(0.0, 2 * beats[0] - mids[0])], mids, [min(float(n), 2 * beats[-1] - mids[-1])]])
    else:
        edges = np.concatenate([beats, [float(n)]])
    edges = np.rint(edges).astype(int)
    out = np.zeros(feature.shape[:-1] + (len(beats),))
    for k in range(len(beats)):
        a, b = edges[k], max(edges[k] + 1, edges[k + 1])
        out[..., k] = how(feature[..., a:min(b, n)], axis=-1) if a < n else 0
    return out


def frame_features(stem_paths: dict) -> dict | None:
    """
    What the beat features are made of, per audio frame: the tracked beats (frame indices), the strength of the
    kick, of the rest of the drums and of the bass, and the chroma of the harmony. None without a usable pulse.
    """
    rhythm_names = [n for n in ("drums", "bass") if n in stem_paths]
    rhythm = _load([stem_paths[n] for n in rhythm_names] if rhythm_names else list(stem_paths.values()))
    if rhythm is None or len(rhythm) < SAMPLE_RATE * 5:
        return None
    _, frames = librosa.beat.beat_track(y=rhythm, sr=SAMPLE_RATE, hop_length=HOP)
    frames = np.asarray(frames, dtype=int)
    if len(frames) < MIN_BEATS:
        return None
    period = float(np.median(np.diff(frames))) * HOP / SAMPLE_RATE
    if not BEAT_PERIOD_RANGE[0] <= period <= BEAT_PERIOD_RANGE[1]:
        return None

    drums = _load([stem_paths["drums"]]) if "drums" in stem_paths else rhythm
    spectrum = np.abs(librosa.stft(drums, hop_length=HOP))
    low = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spectrum[:KICK_BINS], ref=np.max), sr=SAMPLE_RATE)
    high = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spectrum[KICK_BINS:], ref=np.max), sr=SAMPLE_RATE)
    bass_audio = _load([stem_paths["bass"]]) if "bass" in stem_paths else rhythm
    bass = librosa.onset.onset_strength(y=bass_audio, sr=SAMPLE_RATE, hop_length=HOP)
    harmonic = [p for n, p in stem_paths.items() if n not in ("drums", "vocals")]
    chroma = librosa.feature.chroma_cqt(y=_load(harmonic) if harmonic else rhythm, sr=SAMPLE_RATE, hop_length=HOP)

    n_frames = min(chroma.shape[1], len(low), len(bass))
    return {
        "beats": frames[frames < n_frames],
        "low": low[:n_frames], "high": high[:n_frames], "bass": bass[:n_frames], "chroma": chroma[:, :n_frames],
    }


def beat_features_from(frames: dict, centred: bool = False) -> dict:
    """{"times": beat times (s), "low", "high", "bass": one value per beat, "novelty": how much the harmony changes}."""
    beats = frames["beats"]
    chords = _sync(frames["chroma"], beats)
    chords = chords / (np.linalg.norm(chords, axis=0, keepdims=True) + 1e-9)
    novelty = np.concatenate([[0.0], 1 - np.sum(chords[:, 1:] * chords[:, :-1], axis=0)])
    return {
        "times": librosa.frames_to_time(beats, sr=SAMPLE_RATE, hop_length=HOP),
        "low": _sync(frames["low"][None], beats, np.max, centred)[0],
        "high": _sync(frames["high"][None], beats, np.max, centred)[0],
        "bass": _sync(frames["bass"][None], beats, np.max, centred)[0],
        "novelty": novelty,
    }


def beat_features(stem_paths: dict) -> dict | None:
    """The per-beat description of a song, or None when it has no usable pulse."""
    frames = frame_features(stem_paths)
    return None if frames is None else beat_features_from(frames)


def _z(x: np.ndarray) -> np.ndarray:
    return (x - x.mean()) / (x.std() + 1e-9)


def _adjusted_r2(values: np.ndarray, n: int) -> float:
    """How much of a feature's variation is explained by the beat's position in a bar of n, corrected for n."""
    z = _z(values)
    phase = np.arange(len(z)) % n
    means = np.array([z[phase == p].mean() for p in range(n)])
    explained = float(np.sum((means[phase] - z.mean()) ** 2) / (np.sum(z ** 2) + 1e-9))
    return 1 - (1 - explained) * (len(z) - 1) / (len(z) - n)


def bar_length_scores(feats: dict) -> dict:
    return {n: float(np.mean([_adjusted_r2(feats[k], n) for k in ("low", "high", "bass", "novelty")])) for n in CANDIDATES}


# A shorter length that explains this share of what the best one does is the real bar: 6 beats whose accents
# repeat every 3 are bars of 3.
SHORTER_SHARE = 0.85


def choose_bar_length(scores: dict) -> int:
    best = max(scores, key=scores.get)
    shorter = [d for d in scores if d < best and best % d == 0 and scores[d] >= SHORTER_SHARE * scores[best]]
    return min(shorter) if shorter else best


def downbeat_phase(feats: dict, n: int) -> int:
    """Which position in a bar of n beats is the first: the one where kick, bass and harmony change are strongest."""
    score = 1.0 * _z(feats["low"]) + 1.0 * _z(feats["bass"]) + 1.0 * _z(feats["novelty"]) + 0.4 * _z(feats["high"])
    phase = np.arange(len(score)) % n
    return int(np.argmax([score[phase == p].mean() for p in range(n)]))


def confidence_of(scores: dict, n: int) -> float:
    """0 to 1 from how plainly the chosen length stood out and how far it led. Not calibrated against a test set."""
    # Multiples and divisors of n are n counted in a different size, not rivals to it.
    rivals = [v for k, v in scores.items() if k != n and k % n != 0 and n % k != 0]
    margin = scores[n] - max(rivals) if rivals else scores[n]
    return round(float(np.clip(margin / MARGIN_FULL, 0, 1) * np.clip(scores[n] / STRENGTH_FULL, 0, 1)), 2)


def unit_for_period(period: float) -> int:
    """The note a beat is counted as: an eighth when the beat is too quick to be a quarter, else a quarter."""
    return 8 if period < EIGHTH_PERIOD else 4


def bars_from_beats(times: np.ndarray, n: int, phase: int, den: int, end: float) -> dict:
    """The tracked beats cut into whole bars of n from `phase`; the map ends where the last whole bar does."""
    starts = [float(times[i]) for i in range(phase, len(times) - n + 1, n)]
    if not starts:
        return {"bars": [], "end": end}
    period = float(np.median(np.diff(times)))
    last = phase + (len(starts) - 1) * n
    bar_end = float(times[last + n]) if last + n < len(times) else starts[-1] + period * n
    return {
        "bars": [{"start": round(s, 3), "num": n, "den": den} for s in starts],
        "end": round(min(bar_end, end), 3),
    }


def detect_meter(stem_paths: dict, duration: float | None = None) -> dict | None:
    """The bar map of a song, or None when it has no beat to count bars on."""
    feats = beat_features(stem_paths)
    if feats is None:
        return None
    times = feats["times"]
    scores = bar_length_scores(feats)
    n = choose_bar_length(scores)
    phase = downbeat_phase(feats, n)
    period = float(np.median(np.diff(times)))
    den = unit_for_period(period)
    if duration is None:
        duration = float(times[-1] + period)
    cut = bars_from_beats(times, n, phase, den, duration)
    if not cut["bars"]:
        return None
    _log(f"{n} beats a bar from beat {phase}, scores {({k: round(v, 3) for k, v in scores.items()})}")
    return {
        "version": FORMAT_VERSION,
        "algorithm": ALGORITHM,
        "bars": cut["bars"],
        "end": cut["end"],
        "source": "detected",
        "confidence": confidence_of(scores, n),
    }


def detect_meter_from_stems(stem_paths: dict, output_path: str) -> dict:
    """Find a song's bars from its stems and write them to `output_path` as meter.json."""
    if not stem_paths:
        raise ValueError("No stems to find the bars from")
    first = next(iter(stem_paths.values()))
    doc = detect_meter(stem_paths, librosa.get_duration(path=first))
    if doc is None:
        if os.path.exists(output_path):
            os.remove(output_path)
        raise ValueError("This song has no steady beat to count bars on")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    return {"bars": len(doc["bars"]), "perBar": doc["bars"][0]["num"], "confidence": doc["confidence"]}
