"""
Core processing pipeline for Song Practice Studio.
Demucs stem separation → BPM → key detection → bass tab transcription.

Separation strategy (chosen automatically from user's stem selection):

  Single pass — when guitar and piano are NOT requested:
    htdemucs    (4-stem, fast)            standard quality
    htdemucs_ft (4-stem, fine-tuned)      high quality (slower)

  Cascade — when guitar or piano IS requested:
    Pass 1: htdemucs / htdemucs_ft on the full mix → vocals, drums, bass, other₁
    Pass 2: htdemucs_6s on other₁ → guitar, piano, other₂
    Final:  vocals+drums+bass from pass 1, guitar+piano+other from pass 2
    Benefit: guitar/piano model receives a cleaner signal (drums/bass/vocals
    already removed), giving better separation at the cost of 2× processing.

  Stems the model produces that the user did NOT request are merged into
  "other" (if "other" is requested) or discarded.
"""

import json
import os
import sys
import gc
import traceback
from pathlib import Path
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 22050

# htdemucs / htdemucs_6s weights are vendored into the frozen sidecar (see
# fetch_models.py + build.py) so the installed app doesn't need internet
# access on first use. htdemucs_ft (the high_quality first pass) is not
# vendored — it's an extra 4x84MB only needed for that opt-in path, and
# still falls back to demucs's normal network download.
def _bundled_model_repo() -> Path | None:
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)))
        candidate = base / "demucs-models"
    else:
        # Dev mode: use the same vendor/ dir fetch_models.py writes to, if
        # it's been run locally — otherwise fall back to demucs's network
        # download as before.
        candidate = Path(__file__).parent / "vendor" / "demucs-models"
    return candidate if candidate.is_dir() else None

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Binary triad templates (root + third + fifth) for chord recognition.
# Unlike MAJOR_PROFILE/MINOR_PROFILE (Krumhansl-Kessler, tuned for whole-piece
# tonal-center perception), these match a single chord's pitch-class content —
# rotated through all 12 roots to build the 24 major/minor chord templates.
_MAJOR_TRIAD = np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0])
_MINOR_TRIAD = np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0])
CHORD_TEMPLATES = {
    f"{NOTE_NAMES[shift]}:maj": np.roll(_MAJOR_TRIAD, shift) for shift in range(12)
}
CHORD_TEMPLATES.update({
    f"{NOTE_NAMES[shift]}:min": np.roll(_MINOR_TRIAD, shift) for shift in range(12)
})

# Four-note chords, matched only when the seventh is clearly there.
_SEVENTH_SHAPES = {
    "7":    np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    "maj7": np.array([1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1]),
    "min7": np.array([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0]),
}
SEVENTH_TEMPLATES = {
    f"{NOTE_NAMES[shift]}:{quality}": np.roll(shape, shift)
    for quality, shape in _SEVENTH_SHAPES.items()
    for shift in range(12)
}

# Semitones above the root that are chord tones, for slash-chord bass notes.
_CHORD_TONE_OFFSETS = {
    "maj": {4, 7},
    "min": {3, 7},
    "7": {4, 7, 10},
    "maj7": {4, 7, 11},
    "min7": {3, 7, 10},
}

BASS_OPEN_MIDI = [28, 33, 38, 43]
BASS_MAX_FRET  = 24

ALL_STEMS_6S = ["vocals", "drums", "bass", "guitar", "piano", "other"]

# Stems produced by the 4-stem models (pass-1 candidates)
_PASS1_STEMS = {"vocals", "drums", "bass", "other"}
# Stems that come exclusively from the 6s pass-2 model
_PASS2_OWN   = {"guitar", "piano", "other"}
# Bleed-through stems produced by htdemucs_6s in pass 2 (already handled by pass 1)
_PASS2_BLEED = {"vocals", "drums", "bass"}


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# Demucs helper
# ---------------------------------------------------------------------------

def _run_demucs(model_name: str, input_path: str, p0: float, p1: float, on_progress) -> tuple:
    """
    Load and run a Demucs model.  Reports progress from p0 to p1.
    Returns (stem_tensors: dict[str, Tensor], ref: Tensor, samplerate: int).
    Model and source tensors are freed before returning.
    """
    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    span = p1 - p0

    on_progress(p0 + span * 0.00, "stem-separation")
    _log(f"Loading Demucs model ({model_name})...")
    repo = _bundled_model_repo()
    if repo is not None and (repo / f"{model_name}.yaml").exists():
        model = get_model(model_name, repo=repo)
    else:
        model = get_model(model_name)
    model.eval()
    on_progress(p0 + span * 0.07, "stem-separation")

    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    on_progress(p0 + span * 0.13, "stem-separation")

    _log(f"Running {model_name} separation...")
    with torch.no_grad():
        sources = apply_model(model, wav[None], progress=False)[0]
    on_progress(p0 + span * 0.90, "stem-separation")

    samplerate    = model.samplerate
    stem_tensors  = {name: sources[i] for i, name in enumerate(model.sources)}

    del model, sources, wav
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    on_progress(p1, "stem-separation")
    return stem_tensors, ref, samplerate


def _save_stem(tensor, ref, samplerate: int, output_dir: str, name: str) -> str:
    out  = tensor * ref.std() + ref.mean()
    path = os.path.join(output_dir, f"{name}.wav")
    sf.write(path, out.numpy().T, samplerate)
    _log(f"Wrote {name}.wav")
    return path


# ---------------------------------------------------------------------------
# Audio analysis helpers
# ---------------------------------------------------------------------------

def _best_key(chroma_mean) -> tuple:
    """(tonic pitch class, "major" | "minor") whose profile correlates best with the chroma; None for a flat one."""
    chroma_mean = np.asarray(chroma_mean, dtype=float)
    chroma_mean = chroma_mean / (chroma_mean.sum() + 1e-9)
    best_score = -np.inf
    best = None
    for shift in range(12):
        rotated = np.roll(chroma_mean, -shift)
        maj = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
        mn  = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
        if maj > best_score:
            best_score = maj
            best = (shift, "major")
        if mn > best_score:
            best_score = mn
            best = (shift, "minor")
    return best


def _detect_key_chroma(input_path: str) -> str:
    try:
        y, sr = librosa.load(input_path, sr=SAMPLE_RATE, mono=True, duration=60)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        key = _best_key(chroma.mean(axis=1))
        return "Unknown" if key is None else f"{NOTE_NAMES[key[0]]} {key[1]}"
    except Exception as e:
        _log(f"Key detection error: {e}\n{traceback.format_exc()}")
        return "Unknown"


# RMS threshold (relative to the track's own max RMS) below which a window is
# considered silence/no-chord rather than forced into the nearest template.
_NO_CHORD_RMS_RATIO = 0.05
_NO_CHORD_LABEL = "N"


# A seventh chord has to beat the best plain triad by this much (cosine score)
# before it is named: a faint seventh, or noise, should not turn C into Cmaj7.
_SEVENTH_MARGIN = 0.02
# The bass has to hold one pitch class this share of a window's bass energy
# for a slash chord to be reported.
_BASS_DOMINANCE = 0.5
_BASS_FMIN_NOTE = "C1"

# Drums are broadband noise to a chroma and a sung melody adds non-chord tones,
# so chords are read from the song without them.
_CHORD_EXCLUDED_STEMS = {"drums", "vocals"}
# A bass line alone names roots, not chord qualities: without one of these the
# whole mix is the better input.
_CHORD_HARMONY_STEMS = {"guitar", "piano", "other"}
# 2: sevenths and slash chords. 3: read from the stems without drums and vocals.
# 4: windows follow the beats and the labels are decoded with Viterbi.
CHORDS_FORMAT_VERSION = 4

_CHORD_HOP_LENGTH = 512

# Beat tracking: fewer beats than this, or a pulse outside the plausible range
# (median interval, seconds), means the track has no usable beat grid and the
# fixed grid is used instead.
_MIN_BEATS = 8
_BEAT_INTERVAL_RANGE = (0.2, 1.5)
# A window never spans more than this: a slow beat is cut in equal parts so a
# change on the "and" is still resolved.
_MAX_WINDOW_SECONDS = 0.8
# A window shorter than this (a beat right next to the start or the end) is
# folded into its neighbour.
_MIN_WINDOW_SECONDS = 0.15

# Viterbi decoding. The emission score of a state is its cosine similarity with
# the window's chroma; changing chord costs these amounts of score, so a change
# has to be backed by that much evidence to be worth it. Related chords (same
# root, a fifth apart) are the usual confusions and cost less.
_SWITCH_COST = 0.12
_SWITCH_COST_RELATED = 0.07
_SWITCH_COST_SAME_ROOT = 0.04
_SWITCH_COST_NO_CHORD = 0.02
# Chords that belong to the song's key get this much extra score: a nudge for
# ambiguous windows, never enough to override clear evidence.
_KEY_BONUS = 0.02
_SILENT_SCORE = -2.0

_MAJOR_KEY_CHORDS = {"maj": (0, 5, 7), "min": (2, 4, 9), "maj7": (0, 5), "7": (7,), "min7": (2, 4, 9)}
_MINOR_KEY_CHORDS = {"min": (0, 5, 7), "maj": (3, 8, 10, 7), "min7": (0, 5, 7), "maj7": (3, 8), "7": (10, 7)}


def _diatonic_chords(tonic: int, mode: str) -> set:
    table = _MAJOR_KEY_CHORDS if mode == "major" else _MINOR_KEY_CHORDS
    return {
        f"{NOTE_NAMES[(tonic + degree) % 12]}:{quality}"
        for quality, degrees in table.items()
        for degree in degrees
    }


def _transition_costs(state_names: list) -> np.ndarray:
    """Cost of moving from state i to state j (0 on the diagonal)."""
    n = len(state_names)
    roots = [
        NOTE_NAMES.index(s.split(":")[0]) if s != _NO_CHORD_LABEL else None for s in state_names
    ]
    costs = np.full((n, n), _SWITCH_COST)
    for i in range(n):
        for j in range(n):
            if i == j:
                costs[i, j] = 0.0
            elif roots[i] is None or roots[j] is None:
                costs[i, j] = _SWITCH_COST_NO_CHORD
            elif roots[i] == roots[j]:
                costs[i, j] = _SWITCH_COST_SAME_ROOT
            elif (roots[j] - roots[i]) % 12 in (5, 7):
                costs[i, j] = _SWITCH_COST_RELATED
    return costs


def _viterbi(emissions: np.ndarray, costs: np.ndarray) -> list:
    """Highest-scoring state path: sum of emissions minus the cost of every change."""
    n_windows, n_states = emissions.shape
    score = emissions[0].copy()
    back = np.zeros((n_windows, n_states), dtype=int)
    for t in range(1, n_windows):
        # candidates[p, s]: best score ending in p at t-1, then moving to s
        candidates = score[:, None] - costs
        back[t] = np.argmax(candidates, axis=0)
        score = candidates[back[t], np.arange(n_states)] + emissions[t]
    path = [int(np.argmax(score))]
    for t in range(n_windows - 1, 0, -1):
        path.append(int(back[t][path[-1]]))
    path.reverse()
    return path


def _grid_windows(n_frames: int, frames_per_window: int) -> list:
    """(start, end) frame pairs on a fixed grid; a last piece under half a window joins the one before."""
    windows = []
    i = 0
    while i < n_frames:
        j = min(i + frames_per_window, n_frames)
        if windows and j - i < frames_per_window / 2:
            windows[-1] = (windows[-1][0], j)
            break
        windows.append((i, j))
        i = j
    return windows


def _beat_windows(beat_frames, n_frames: int, frame_dur: float) -> list:
    """
    (start, end) frame pairs that follow the beats: one window per beat, the
    stretch before the first beat and after the last one included. Long beats
    are cut into equal parts, slivers are folded into the window next to them.
    """
    min_frames = max(1, round(_MIN_WINDOW_SECONDS / frame_dur))
    max_frames = max(1, round(_MAX_WINDOW_SECONDS / frame_dur))
    edges = sorted({0, n_frames, *(int(b) for b in beat_frames if 0 < int(b) < n_frames)})
    kept = [edges[0]]
    for edge in edges[1:-1]:
        if edge - kept[-1] >= min_frames:
            kept.append(edge)
    if edges[-1] - kept[-1] < min_frames and len(kept) > 1:
        kept.pop()
    kept.append(edges[-1])

    windows = []
    for start, end in zip(kept, kept[1:]):
        parts = max(1, -(-(end - start) // max_frames))
        cuts = [start + round((end - start) * k / parts) for k in range(parts + 1)]
        windows.extend((a, b) for a, b in zip(cuts, cuts[1:]) if b > a)
    return windows


def _slash_bass(chord: str, bass_win):
    """The bass note when one pitch class dominates the bass and is a chord tone other than the root."""
    if bass_win is None or bass_win.sum() <= 1e-6:
        return None
    pc = int(np.argmax(bass_win))
    if bass_win[pc] / bass_win.sum() < _BASS_DOMINANCE:
        return None
    root_name, quality = chord.split(":")
    offset = (pc - NOTE_NAMES.index(root_name)) % 12
    if offset != 0 and offset in _CHORD_TONE_OFFSETS[quality]:
        return NOTE_NAMES[pc]
    return None


def _chords_from_signal(y, sr, bass_y=None, hop_seconds: float = 1.0, beat_frames=None) -> list:
    """
    Windowed chroma -> chord-template matching over the whole signal, decoded
    with Viterbi so one noisy window cannot flip a chord and a change has to be
    backed by evidence. Windows follow `beat_frames` (chroma frame indices at
    hop 512) when given, otherwise a fixed grid of `hop_seconds`.
    Returns {"start", "end", "chord"} segments (chord like "C:maj", "G:7",
    "A:min7"), with "bass" (a note name) when the bass stem plays a chord tone
    other than the root.
    """
    hop_length  = _CHORD_HOP_LENGTH
    frame_dur   = hop_length / sr
    frames_per_window = max(1, round(hop_seconds / frame_dur))

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    rms    = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    n_frames = chroma.shape[1]
    if n_frames == 0:
        return []

    bass_chroma = None
    if bass_y is not None and len(bass_y) > 0:
        bass_chroma = librosa.feature.chroma_cqt(
            y=bass_y, sr=sr, hop_length=hop_length, fmin=librosa.note_to_hz(_BASS_FMIN_NOTE), n_octaves=4,
        )

    def _unit(templates):
        names = list(templates.keys())
        matrix = np.stack([templates[n] for n in names]).astype(float)
        return names, matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)

    triad_names, triad_matrix = _unit(CHORD_TEMPLATES)
    seventh_names, seventh_matrix = _unit(SEVENTH_TEMPLATES)
    chord_names = triad_names + seventh_names
    template_matrix = np.vstack([triad_matrix, seventh_matrix])
    state_names = chord_names + [_NO_CHORD_LABEL]
    n_chords = len(chord_names)

    # What each state is worth before the window is looked at: a seventh pays
    # the margin, a chord of the song's key gets the bonus.
    prior = np.zeros(n_chords)
    prior[len(triad_names):] -= _SEVENTH_MARGIN

    max_rms = float(rms.max()) if len(rms) else 0.0
    n_common = min(n_frames, len(rms))
    loud = rms[:n_common] >= _NO_CHORD_RMS_RATIO * max_rms if max_rms > 0 else np.zeros(n_common, dtype=bool)
    if loud.any():
        key = _best_key(chroma[:, :n_common][:, loud].mean(axis=1))
        if key is not None:
            diatonic = _diatonic_chords(*key)
            prior += np.array([_KEY_BONUS if name in diatonic else 0.0 for name in chord_names])

    if beat_frames is not None and len(beat_frames) > 0:
        windows = _beat_windows(beat_frames, n_frames, frame_dur)
    else:
        windows = _grid_windows(n_frames, frames_per_window)

    emissions = np.full((len(windows), n_chords + 1), _SILENT_SCORE)
    for w, (i, j) in enumerate(windows):
        chroma_win = chroma[:, i:j].mean(axis=1)
        rms_win    = float(rms[i:j].mean()) if j > i else 0.0
        norm = np.linalg.norm(chroma_win)
        if max_rms <= 0 or rms_win < _NO_CHORD_RMS_RATIO * max_rms or norm < 1e-6:
            emissions[w, n_chords] = 0.0
        else:
            emissions[w, :n_chords] = template_matrix @ (chroma_win / norm) + prior

    path = _viterbi(emissions, _transition_costs(state_names))

    labels = []
    for (i, j), state in zip(windows, path):
        name = state_names[state]
        if name == _NO_CHORD_LABEL:
            labels.append((_NO_CHORD_LABEL, None))
            continue
        bass_win = None
        if bass_chroma is not None and bass_chroma.shape[1] >= j:
            bass_win = bass_chroma[:, i:j].mean(axis=1)
        labels.append((name, _slash_bass(name, bass_win)))

    # A bass note heard in one window only, inside a chord that otherwise
    # holds the same bass, is noise rather than a new segment.
    for k in range(1, len(labels) - 1):
        prev, cur, nxt = labels[k - 1], labels[k], labels[k + 1]
        if prev == nxt and cur != prev and cur[0] == prev[0]:
            labels[k] = prev

    duration = n_frames * frame_dur
    segments = []

    def _emit(start, end, label):
        if label[0] == _NO_CHORD_LABEL:
            return
        seg = {"start": round(start, 3), "end": round(end, 3), "chord": label[0]}
        if label[1] is not None:
            seg["bass"] = label[1]
        segments.append(seg)

    seg_start = windows[0][0] * frame_dur
    seg_label = labels[0]
    for (i, _), label in zip(windows[1:], labels[1:]):
        if label != seg_label:
            _emit(seg_start, i * frame_dur, seg_label)
            seg_start = i * frame_dur
            seg_label = label
    _emit(seg_start, duration, seg_label)

    return segments


def _beat_frames(paths: dict) -> np.ndarray | None:
    """
    Beat positions as chroma frame indices (hop 512), tracked on the rhythm
    section when there is one (drums, plus bass) and on everything otherwise.
    None when the track has no usable pulse.
    """
    try:
        rhythm = {k: v for k, v in paths.items() if k in ("drums", "bass")} if "drums" in paths else paths
        y = _sum_audio_files(rhythm)
        _, frames = librosa.beat.beat_track(y=y, sr=SAMPLE_RATE, hop_length=_CHORD_HOP_LENGTH)
    except Exception as e:
        _log(f"Beat tracking error (the chords use a fixed grid): {e}\n{traceback.format_exc()}")
        return None
    frames = np.asarray(frames, dtype=int)
    if len(frames) < _MIN_BEATS:
        return None
    interval = float(np.median(np.diff(frames))) * _CHORD_HOP_LENGTH / SAMPLE_RATE
    if not _BEAT_INTERVAL_RANGE[0] <= interval <= _BEAT_INTERVAL_RANGE[1]:
        return None
    return frames


def _sum_audio_files(paths: dict) -> np.ndarray:
    """Mono sum of the given audio files at SAMPLE_RATE, padded to the longest."""
    mix = None
    for path in paths.values():
        y, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
        if mix is None:
            mix = y.copy()
        else:
            n = max(len(mix), len(y))
            mix = np.pad(mix, (0, n - len(mix)))
            mix[: len(y)] += y
    return mix


def _harmonic_stem_paths(stem_paths: dict) -> dict | None:
    """
    The stems chords should be read from: everything but drums and vocals.
    None when what is left has no stem that carries the harmony, in which case
    the caller reads the whole mix instead.
    """
    harmonic = {name: path for name, path in stem_paths.items() if name not in _CHORD_EXCLUDED_STEMS}
    return harmonic if harmonic.keys() & _CHORD_HARMONY_STEMS else None


def _detect_chords(stem_paths: dict, input_path: str | None = None) -> tuple:
    """
    Chord segments and the length (seconds) of the audio they were read from.
    Reads the song without its drums and vocals; a song that has no stem to do
    that from is read from `input_path`, or from the sum of every stem when
    there is no original file.
    """
    sources = _harmonic_stem_paths(stem_paths)
    if sources is None:
        sources = {"mix": input_path} if input_path else stem_paths
    _log(f"Chords read from: {', '.join(sources)}")
    mix = _sum_audio_files(sources)
    bass_y = None
    if "bass" in stem_paths:
        bass_y, _ = librosa.load(stem_paths["bass"], sr=SAMPLE_RATE, mono=True)
    beats = _beat_frames(stem_paths if stem_paths else sources)
    _log(f"Chord windows follow {'the beats' if beats is not None else 'a fixed grid'}")
    return _chords_from_signal(mix, SAMPLE_RATE, bass_y, beat_frames=beats), len(mix) / SAMPLE_RATE


def _detect_chords_chroma(input_path: str, hop_seconds: float = 1.0, bass_path: str | None = None) -> list:
    y, sr = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
    bass_y = None
    if bass_path:
        bass_y, _ = librosa.load(bass_path, sr=SAMPLE_RATE, mono=True)
    return _chords_from_signal(y, sr, bass_y, hop_seconds)


def detect_chords_from_stems(stem_paths: dict, output_path: str) -> dict:
    """
    Detect the chords again from a song's separated stems (without the drums
    and vocals when it has stems to do that from) and write them to
    `output_path` as chords.json.
    """
    if not stem_paths:
        raise ValueError("No stems to detect chords from")
    segments, duration = _detect_chords(stem_paths)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump({"version": CHORDS_FORMAT_VERSION, "duration": duration, "segments": segments}, f)
    return {"segments": len(segments)}


def _assign_fret(midi_pitch: int, prev_string: int, prev_fret: int) -> tuple:
    candidates = []
    for s, open_midi in enumerate(BASS_OPEN_MIDI):
        fret = midi_pitch - open_midi
        if 0 <= fret <= BASS_MAX_FRET:
            position_jump = abs(fret - prev_fret) + abs(s - prev_string) * 2
            candidates.append((position_jump + fret * 0.1, s, fret))
    if not candidates:
        return 0, max(0, min(BASS_MAX_FRET, midi_pitch - BASS_OPEN_MIDI[0]))
    candidates.sort()
    _, best_string, best_fret = candidates[0]
    return best_string, best_fret


def _transcribe_bass(bass_path: str) -> list:
    y, sr = librosa.load(bass_path, sr=SAMPLE_RATE, mono=True)

    HOP = 512
    frame_dur = HOP / sr
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("E1"),
        fmax=librosa.note_to_hz("G4"),
        sr=sr, frame_length=2048, hop_length=HOP, fill_na=None,
    )
    times = librosa.times_like(f0, sr=sr, hop_length=HOP)

    def _midi_float(f):
        return float(librosa.hz_to_midi(f))

    notes = []
    prev_string, prev_fret = 0, 0
    n, i = len(f0), 0

    while i < n:
        if not voiced_flag[i] or f0[i] is None or np.isnan(f0[i]) or f0[i] <= 0:
            i += 1
            continue

        start_i  = i
        midi_ref = _midi_float(f0[i])
        pitch    = int(round(midi_ref))

        while (
            i < n
            and voiced_flag[i]
            and f0[i] is not None
            and not np.isnan(f0[i])
            and f0[i] > 0
            and abs(_midi_float(f0[i]) - midi_ref) <= 1.5
        ):
            i += 1

        note_dur = float(times[i - 1]) + frame_dur - float(times[start_i])
        if note_dur < 0.04:
            continue

        string_idx, fret    = _assign_fret(pitch, prev_string, prev_fret)
        prev_string, prev_fret = string_idx, fret

        notes.append({
            "time":     round(float(times[start_i]), 4),
            "duration": round(note_dur, 4),
            "pitch":    pitch,
            "string":   string_idx,
            "fret":     fret,
        })

    return notes


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def process(
    input_path:       str,
    output_dir:       str,
    stems_to_extract: list | None = None,
    high_quality:     bool        = False,
    on_progress                   = None,
) -> dict:
    """
    Full pipeline: separate stems, detect BPM and key, transcribe bass tab.

    stems_to_extract: subset of ["vocals","drums","bass","guitar","piano","other"].
      Defaults to all 6.  Drives model selection:
        • No guitar/piano → single pass with htdemucs (or htdemucs_ft if high_quality)
        • Guitar or piano → cascade: htdemucs(/ft) on full mix, then htdemucs_6s on "other"

    high_quality: use htdemucs_ft instead of htdemucs for the first pass.
      Has no effect on htdemucs_6s (no fine-tuned 6s variant exists).
    """
    if on_progress is None:
        on_progress = lambda v, s: None
    if stems_to_extract is None:
        stems_to_extract = list(ALL_STEMS_6S)

    stems_set    = set(stems_to_extract)
    if not stems_set & set(ALL_STEMS_6S):
        raise ValueError(f"No valid stems requested: {stems_to_extract!r}")
    need_cascade = bool(stems_set & {"guitar", "piano"})
    first_model  = "htdemucs_ft" if high_quality else "htdemucs"

    os.makedirs(output_dir, exist_ok=True)
    stem_paths: dict[str, str] = {}

    # ===================================================================
    # Stage 1: Demucs separation (0.00 – 0.75)
    # ===================================================================
    if need_cascade:
        # ------------------------------------------------------------------
        # Pass 1 (0.00–0.40): full-mix 4-stem split
        # ------------------------------------------------------------------
        p1_tensors, ref1, sr1 = _run_demucs(first_model, input_path, 0.00, 0.40, on_progress)

        # Save requested stems that live in the 4-stem model
        for name in stems_to_extract:
            if name in _PASS1_STEMS and name != "other" and name in p1_tensors:
                stem_paths[name] = _save_stem(p1_tensors[name], ref1, sr1, output_dir, name)

        # Write pass-1 "other" to a temp file for pass-2 input (always needed)
        other1_path = os.path.join(output_dir, "_other_pass1.wav")
        sf.write(other1_path, (p1_tensors["other"] * ref1.std() + ref1.mean()).numpy().T, sr1)

        del p1_tensors, ref1
        gc.collect()

        # ------------------------------------------------------------------
        # Pass 2 (0.40–0.75): guitar/piano split on the "other" residual
        # ------------------------------------------------------------------
        p2_tensors, ref2, sr2 = _run_demucs("htdemucs_6s", other1_path, 0.40, 0.75, on_progress)

        # Discard bleed-through of vocals/drums/bass that htdemucs_6s produces
        # from the already-cleaned signal — they are tiny and adding them back
        # would reintroduce the artefacts we removed in pass 1.
        for name in stems_to_extract:
            if name in _PASS2_BLEED or name not in _PASS2_OWN:
                continue
            if name not in p2_tensors:
                continue

            tensor = p2_tensors[name]

            if name == "other":
                # Fold any unrequested guitar/piano into "other"
                for candidate in ("guitar", "piano"):
                    if candidate not in stems_set and candidate in p2_tensors:
                        tensor = tensor + p2_tensors[candidate]

            stem_paths[name] = _save_stem(tensor, ref2, sr2, output_dir, name)

        del p2_tensors, ref2
        gc.collect()

        try:
            os.remove(other1_path)
        except OSError:
            pass

    else:
        # ------------------------------------------------------------------
        # Single pass (0.00–0.75)
        # ------------------------------------------------------------------
        tensors, ref, sr = _run_demucs(first_model, input_path, 0.00, 0.75, on_progress)

        unwanted = [n for n in tensors if n not in stems_set and n != "other"]
        for name in stems_to_extract:
            if name not in tensors:
                continue
            tensor = tensors[name]
            if name == "other" and unwanted:
                for u in unwanted:
                    tensor = tensor + tensors[u]
            stem_paths[name] = _save_stem(tensor, ref, sr, output_dir, name)

        del tensors, ref
        gc.collect()

    # Duration from first written stem
    duration = librosa.get_duration(path=next(iter(stem_paths.values())))

    # ===================================================================
    # Stage 2: BPM detection (0.75 – 0.86)
    # ===================================================================
    on_progress(0.75, "bpm-detection")
    _log("Estimating BPM...")
    detected_bpm = None
    try:
        full_mix, sr_full = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
        tempo = librosa.beat.tempo(y=full_mix, sr=sr_full)
        detected_bpm = round(float(tempo[0]), 1) if len(tempo) > 0 else None
        del full_mix
        gc.collect()
    except Exception as e:
        _log(f"BPM error: {e}\n{traceback.format_exc()}")
    on_progress(0.86, "bpm-detection")

    # ===================================================================
    # Stage 3: Key detection (0.86 – 0.92)
    # ===================================================================
    on_progress(0.86, "key-detection")
    _log("Detecting key...")
    detected_key = _detect_key_chroma(input_path)
    on_progress(0.92, "key-detection")

    # ===================================================================
    # Stage 4: Chord detection (0.92 – 0.96)
    # ===================================================================
    on_progress(0.92, "chord-detection")
    _log("Detecting chords...")
    chords_written = False
    try:
        chord_segments, _ = _detect_chords(stem_paths, input_path)
        chords_path = os.path.join(output_dir, "chords.json")
        with open(chords_path, "w", encoding="utf-8") as f:
            json.dump({"version": CHORDS_FORMAT_VERSION, "duration": duration, "segments": chord_segments}, f)
        _log(f"Chords written: {len(chord_segments)} segments → {chords_path}")
        chords_written = True
    except Exception as e:
        _log(f"Chord detection error (non-fatal): {e}\n{traceback.format_exc()}")
    on_progress(0.96, "chord-detection")

    # ===================================================================
    # Stage 5: Bass tab transcription (0.96 – 1.00)
    # ===================================================================
    on_progress(0.96, "bass-tab")
    bass_tab_written = False
    if "bass" in stem_paths:
        _log("Transcribing bass tab...")
        try:
            notes    = _transcribe_bass(stem_paths["bass"])
            tab_data = {"version": 1, "duration": duration, "notes": notes}
            tab_path = os.path.join(output_dir, "bass_tab.json")
            with open(tab_path, "w", encoding="utf-8") as f:
                json.dump(tab_data, f)
            _log(f"Bass tab written: {len(notes)} notes → {tab_path}")
            bass_tab_written = True
        except Exception as e:
            _log(f"Bass tab error (non-fatal): {e}\n{traceback.format_exc()}")

    on_progress(1.0, "complete")
    _log("Processing complete.")

    return {
        "stems":       {name: str(p) for name, p in stem_paths.items()},
        "duration":    duration,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
        "chords":      chords_written,
        "bassTab":     bass_tab_written,
    }


def pitch_shift_song(song_dir: str, cache_dir: str, stem_names: list, n_steps: float, on_progress=None):
    """Pitch-shift each of `stem_names` by n_steps semitones (ported from VPS,
    generalized from the fixed vocals/instrumental pair to SPS's dynamic stems).

    Results are written to cache_dir/{stem}.wav. Uses the phase vocoder so
    tempo is preserved.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    paths = {}

    for i, name in enumerate(stem_names):
        input_path = os.path.join(song_dir, f"{name}.wav")
        output_path = os.path.join(cache_dir, f"{name}.wav")

        on_progress(i / len(stem_names), f"loading-{name}")
        audio, sr = librosa.load(input_path, sr=None, mono=False)

        on_progress((i + 0.5) / len(stem_names), f"shifting-{name}")
        if audio.ndim == 1:
            shifted = librosa.effects.pitch_shift(
                audio, sr=sr, n_steps=n_steps, res_type="kaiser_fast"
            )
        else:
            shifted = np.stack([
                librosa.effects.pitch_shift(
                    audio[ch], sr=sr, n_steps=n_steps, res_type="kaiser_fast"
                )
                for ch in range(audio.shape[0])
            ])

        sf.write(output_path, shifted.T if shifted.ndim > 1 else shifted, sr)
        paths[name] = output_path
        del audio, shifted
        gc.collect()

    on_progress(1.0, "complete")
    return {"stems": paths}
