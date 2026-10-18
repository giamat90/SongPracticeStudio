"""
The chord vocabulary of the neural model and how its output becomes the app's chords.

Pure numpy, so it is tested without torch. The model (BTC, Park et al. 2019) names
170 classes: 12 roots x 14 qualities, "X" (unknown) and "N" (no chord). The app
writes and edits ten qualities (`CHORD_QUALITIES` in library.rs / chordNames.ts),
so the 14 are folded onto those, and the folding is done on the probabilities,
before the decision: two classes that fold to the same chord (maj6 and 6, sus4
and sus4) must not split a segment between them.
"""

import numpy as np

ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MODEL_QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"]
NUM_CLASSES = 170
UNKNOWN, NO_CHORD = 168, 169

APP_QUALITIES = ["maj", "min", "7", "maj7", "min7", "sus2", "sus4", "dim", "aug", "6"]

# A chord the app cannot write is shown as the nearest one it can: a minor sixth or
# minor-major seventh as minor, a diminished seventh as diminished, a half-diminished
# seventh as a minor seventh (it keeps the minor third and the seventh).
FOLD = {
    "maj": "maj", "min": "min", "7": "7", "maj7": "maj7", "min7": "min7", "sus2": "sus2", "sus4": "sus4",
    "dim": "dim", "aug": "aug", "maj6": "6", "min6": "min", "minmaj7": "min", "dim7": "dim", "hdim7": "min7",
}

NO_CHORD_INDEX = len(ROOTS) * len(APP_QUALITIES)
APP_LABELS = [f"{root}:{quality}" for root in ROOTS for quality in APP_QUALITIES] + ["N"]

# Segments are written with this many alternatives, like the classical detector.
ALTERNATIVES = 6


def folding_matrix() -> np.ndarray:
    """(170, len(APP_LABELS)) 0/1 matrix: summing a class's probability into the app chord it folds to."""
    matrix = np.zeros((NUM_CLASSES, len(APP_LABELS)))
    for i in range(12 * len(MODEL_QUALITIES)):
        root, quality = divmod(i, len(MODEL_QUALITIES))
        target = APP_QUALITIES.index(FOLD[MODEL_QUALITIES[quality]])
        matrix[i, root * len(APP_QUALITIES) + target] = 1.0
    matrix[UNKNOWN, NO_CHORD_INDEX] = 1.0
    matrix[NO_CHORD, NO_CHORD_INDEX] = 1.0
    return matrix


_FOLDING = folding_matrix()


def fold_probabilities(probs: np.ndarray) -> np.ndarray:
    """(frames, 170) class probabilities -> (frames, 121) probabilities of the app's chords and "no chord"."""
    return np.asarray(probs, dtype=np.float64) @ _FOLDING


def segments_from_probabilities(probs: np.ndarray, frame_seconds: float) -> list:
    """
    The app's chord segments from per-frame class probabilities: the most probable
    app chord per frame, runs of the same chord merged, "no chord" left as a gap.
    Each segment carries the mean probability of its chord as `confidence` and the
    most probable other chords as `alternatives`, in the form chords.json v6 uses.
    """
    folded = fold_probabilities(probs)
    if len(folded) == 0:
        return []
    best = folded.argmax(axis=1)
    segments = []
    start = 0
    for i in range(1, len(best) + 1):
        if i < len(best) and best[i] == best[start]:
            continue
        label = int(best[start])
        if label != NO_CHORD_INDEX:
            span = folded[start:i]
            mean = span.mean(axis=0)
            ranked = [int(j) for j in np.argsort(-mean) if j != label and j != NO_CHORD_INDEX][:ALTERNATIVES]
            segments.append({
                "start": round(start * frame_seconds, 3),
                "end": round(i * frame_seconds, 3),
                "chord": APP_LABELS[label],
                "confidence": round(float(mean[label]), 2),
                "alternatives": [{"chord": APP_LABELS[j], "fit": round(float(mean[j]), 2)} for j in ranked],
            })
        start = i
    return segments
