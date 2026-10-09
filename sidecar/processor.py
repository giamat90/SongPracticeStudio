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

def _detect_key_chroma(input_path: str) -> str:
    try:
        y, sr = librosa.load(input_path, sr=SAMPLE_RATE, mono=True, duration=60)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = chroma.mean(axis=1)
        chroma_mean /= chroma_mean.sum() + 1e-9

        best_score = -np.inf
        best_key   = "Unknown"
        for shift in range(12):
            rotated = np.roll(chroma_mean, -shift)
            maj = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
            mn  = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
            if maj > best_score:
                best_score = maj
                best_key   = f"{NOTE_NAMES[shift]} major"
            if mn > best_score:
                best_score = mn
                best_key   = f"{NOTE_NAMES[shift]} minor"
        return best_key
    except Exception as e:
        _log(f"Key detection error: {e}\n{traceback.format_exc()}")
        return "Unknown"


# RMS threshold (relative to the track's own max RMS) below which a window is
# considered silence/no-chord rather than forced into the nearest template.
_NO_CHORD_RMS_RATIO = 0.05
_NO_CHORD_LABEL = "N"


def _detect_chords_chroma(input_path: str, hop_seconds: float = 1.0) -> list:
    """
    Windowed chroma → chord-template matching over the whole song.
    Returns a list of {"start", "end", "chord"} segments (chord like "C:maj").
    """
    y, sr = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)

    hop_length  = 512
    frame_dur   = hop_length / sr
    frames_per_window = max(1, round(hop_seconds / frame_dur))

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    rms    = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    n_frames = chroma.shape[1]

    template_names   = list(CHORD_TEMPLATES.keys())
    template_matrix  = np.stack([CHORD_TEMPLATES[n] for n in template_names])
    template_norms   = template_matrix / (np.linalg.norm(template_matrix, axis=1, keepdims=True) + 1e-9)

    max_rms = float(rms.max()) if len(rms) else 0.0

    window_labels = []
    window_times  = []
    i = 0
    while i < n_frames:
        j = min(i + frames_per_window, n_frames)
        chroma_win = chroma[:, i:j].mean(axis=1)
        rms_win    = float(rms[i:j].mean()) if j > i else 0.0

        if max_rms <= 0 or rms_win < _NO_CHORD_RMS_RATIO * max_rms:
            label = _NO_CHORD_LABEL
        else:
            norm = np.linalg.norm(chroma_win) + 1e-9
            scores = template_norms @ (chroma_win / norm)
            label  = template_names[int(np.argmax(scores))]

        window_labels.append(label)
        window_times.append(i * frame_dur)
        i = j

    # Median-filter to suppress single-window flicker.
    filt_window = 3
    if len(window_labels) >= filt_window:
        from collections import Counter
        smoothed = list(window_labels)
        half = filt_window // 2
        for idx in range(half, len(window_labels) - half):
            neighborhood = window_labels[idx - half: idx + half + 1]
            smoothed[idx] = Counter(neighborhood).most_common(1)[0][0]
        window_labels = smoothed

    # Merge consecutive identical labels into segments, dropping "N".
    duration = n_frames * frame_dur
    segments = []
    seg_start = window_times[0] if window_times else 0.0
    seg_label = window_labels[0] if window_labels else _NO_CHORD_LABEL
    for t, label in zip(window_times[1:], window_labels[1:]):
        if label != seg_label:
            if seg_label != _NO_CHORD_LABEL:
                segments.append({"start": round(seg_start, 3), "end": round(t, 3), "chord": seg_label})
            seg_start = t
            seg_label = label
    if window_labels and seg_label != _NO_CHORD_LABEL:
        segments.append({"start": round(seg_start, 3), "end": round(duration, 3), "chord": seg_label})

    return segments


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
        chord_segments = _detect_chords_chroma(input_path)
        chords_path = os.path.join(output_dir, "chords.json")
        with open(chords_path, "w", encoding="utf-8") as f:
            json.dump({"version": 1, "duration": duration, "segments": chord_segments}, f)
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
