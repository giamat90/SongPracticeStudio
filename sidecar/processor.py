"""
Core processing pipeline for Song Analyzer.
Demucs stem separation → BPM → key detection → bass tab transcription.

Model is chosen based on requested stems:
  htdemucs_6s  — when guitar or piano is requested (6 stems)
  htdemucs     — otherwise (4 stems: vocals, drums, bass, other)

Stems not requested by the user are merged into "other" (if "other" is
requested) or discarded. This lets users get a complete mix of everything
they don't care about as a single "other" track.
"""

import json
import os
import sys
import gc
import traceback
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 22050

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Standard 4-string bass open-string MIDI pitches: E1, A1, D2, G2
BASS_OPEN_MIDI = [28, 33, 38, 43]
BASS_MAX_FRET  = 24

ALL_STEMS_6S = ["vocals", "drums", "bass", "guitar", "piano", "other"]


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _detect_key_chroma(input_path: str) -> str:
    """Fast key detection via chroma features (no pitch extraction needed)."""
    try:
        y, sr = librosa.load(input_path, sr=SAMPLE_RATE, mono=True, duration=60)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = chroma.mean(axis=1)
        chroma_mean /= chroma_mean.sum() + 1e-9

        best_score = -np.inf
        best_key = "Unknown"
        for shift in range(12):
            rotated = np.roll(chroma_mean, -shift)
            maj = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
            mn  = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
            if maj > best_score:
                best_score = maj
                best_key = f"{NOTE_NAMES[shift]} major"
            if mn > best_score:
                best_score = mn
                best_key = f"{NOTE_NAMES[shift]} minor"
        return best_key
    except Exception as e:
        _log(f"Key detection error: {e}\n{traceback.format_exc()}")
        return "Unknown"


def _assign_fret(midi_pitch: int, prev_string: int, prev_fret: int) -> tuple:
    """
    Return (string_index, fret) for a MIDI pitch on standard 4-string bass.
    Scores candidates by position_jump + fret * 0.1 (prefer lower fret as tie-breaker).
    string_index: 0=E, 1=A, 2=D, 3=G
    """
    candidates = []
    for s, open_midi in enumerate(BASS_OPEN_MIDI):
        fret = midi_pitch - open_midi
        if 0 <= fret <= BASS_MAX_FRET:
            position_jump = abs(fret - prev_fret) + abs(s - prev_string) * 2
            cost = position_jump + fret * 0.1
            candidates.append((cost, s, fret))
    if not candidates:
        # Pitch out of range: clamp to low E string
        return 0, max(0, min(BASS_MAX_FRET, midi_pitch - BASS_OPEN_MIDI[0]))
    candidates.sort()
    _, best_string, best_fret = candidates[0]
    return best_string, best_fret


def _transcribe_bass(bass_path: str) -> list:
    """
    Transcribe bass stem to note events, then assign fret positions.
    Tries CREPE (neural monophonic tracker, ~20MB model) first; falls back to
    librosa pyin if CREPE is unavailable. The note segmentation logic below is
    identical regardless of which backend supplies the frames.
    Returns [{time, duration, pitch, string, fret}].
    """
    y, sr = librosa.load(bass_path, sr=SAMPLE_RATE, mono=True)

    # --- Frame-level pitch extraction ---
    try:
        import crepe
        _log("Running CREPE pitch tracking (medium)...")
        time_arr, freq_arr, conf_arr, _ = crepe.predict(
            y, sr,
            model_capacity='medium',
            viterbi=True,    # Viterbi decoding smooths the pitch contour
            step_size=10,    # 10 ms hop
            verbose=0,
        )
        voiced_flag = conf_arr >= 0.5
        f0        = freq_arr
        times     = time_arr
        frame_dur = 0.010   # 10 ms

        def _midi_float(f: float) -> float:
            return 12.0 * np.log2(f / 440.0) + 69.0

    except Exception as e:
        _log(f"CREPE unavailable, falling back to pyin: {e}")
        HOP = 512
        frame_dur = HOP / sr
        f0, voiced_flag, _ = librosa.pyin(
            y,
            fmin=librosa.note_to_hz("E1"),
            fmax=librosa.note_to_hz("G4"),
            sr=sr,
            frame_length=2048,
            hop_length=HOP,
            fill_na=None,
        )
        times = librosa.times_like(f0, sr=sr, hop_length=HOP)

        def _midi_float(f: float) -> float:
            return float(librosa.hz_to_midi(f))

    # --- Note segmentation (unchanged logic, shared by both backends) ---
    notes = []
    prev_string, prev_fret = 0, 0
    n = len(f0)
    i = 0

    while i < n:
        if not voiced_flag[i] or f0[i] is None or np.isnan(f0[i]) or f0[i] <= 0:
            i += 1
            continue

        start_i  = i
        midi_ref = _midi_float(f0[i])        # float for comparison
        pitch    = int(round(midi_ref))       # integer for storage

        # Extend while voiced and within ±1.5 semitones of the onset pitch
        while (
            i < n
            and voiced_flag[i]
            and f0[i] is not None
            and not np.isnan(f0[i])
            and f0[i] > 0
            and abs(_midi_float(f0[i]) - midi_ref) <= 1.5
        ):
            i += 1

        note_start = float(times[start_i])
        note_end   = float(times[i - 1]) + frame_dur
        note_dur   = note_end - note_start

        if note_dur < 0.04:  # discard < 40 ms (noise / transient)
            continue

        string_idx, fret = _assign_fret(pitch, prev_string, prev_fret)
        prev_string, prev_fret = string_idx, fret

        notes.append({
            "time":     round(note_start, 4),
            "duration": round(note_dur,   4),
            "pitch":    pitch,
            "string":   string_idx,
            "fret":     fret,
        })

    return notes


def process(input_path: str, output_dir: str, stems_to_extract=None, on_progress=None) -> dict:
    """
    Full pipeline: separate stems, detect BPM and key, transcribe bass tab.

    stems_to_extract: list of stem names the user wants (e.g. ["vocals", "bass"]).
      Defaults to all 6 stems. Model is chosen automatically:
        htdemucs_6s  when guitar or piano is in the list
        htdemucs     otherwise (faster, tuned for 4-stem separation)
      Stems the model produces that the user did NOT request are merged into
      "other" (if "other" is requested) or discarded.
    """
    if on_progress is None:
        on_progress = lambda v, s: None
    if stems_to_extract is None:
        stems_to_extract = list(ALL_STEMS_6S)

    stems_set  = set(stems_to_extract)
    need_6s    = bool(stems_set & {"guitar", "piano"})
    model_name = "htdemucs_6s" if need_6s else "htdemucs"

    os.makedirs(output_dir, exist_ok=True)

    # ===================================================================
    # Stage 1: Demucs separation (0.00 – 0.75)
    # ===================================================================
    on_progress(0.0, "stem-separation")
    _log(f"Loading Demucs model ({model_name})...")

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = get_model(model_name)
    model.eval()
    on_progress(0.05, "stem-separation")

    wav = AudioFile(input_path).read(
        streams=0, samplerate=model.samplerate, channels=model.audio_channels
    )
    ref = wav.mean(0)
    wav = (wav - ref.mean()) / ref.std()
    on_progress(0.10, "stem-separation")

    _log("Running Demucs separation...")
    with torch.no_grad():
        sources = apply_model(model, wav[None], progress=False)[0]
    on_progress(0.70, "stem-separation")

    # Map model output names → normalized tensors
    model_tensors = {name: sources[i] for i, name in enumerate(model.sources)}

    # Model stems NOT requested by the user (will be merged into "other" if requested)
    unwanted = [n for n in model_tensors if n not in stems_set and n != "other"]

    stem_paths = {}
    for name in stems_to_extract:
        if name not in model_tensors:
            _log(f"Stem '{name}' not produced by {model_name}, skipping.")
            continue

        tensor = model_tensors[name]

        # Fold unwanted model stems into "other"
        if name == "other" and unwanted:
            for u in unwanted:
                tensor = tensor + model_tensors[u]

        out_tensor = tensor * ref.std() + ref.mean()
        path = os.path.join(output_dir, f"{name}.wav")
        sf.write(path, out_tensor.numpy().T, model.samplerate)
        stem_paths[name] = path
        _log(f"Wrote {name}.wav")

    on_progress(0.75, "stem-separation")

    # Duration from first written stem
    first_stem_path = next(iter(stem_paths.values()))
    duration = librosa.get_duration(path=first_stem_path)

    _log("Freeing Demucs from memory...")
    del model, sources, wav, ref, model_tensors
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

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
    # Stage 4: Bass tab transcription (0.92 – 1.00)
    # ===================================================================
    on_progress(0.92, "bass-tab")
    bass_tab_written = False
    if "bass" in stem_paths:
        _log("Transcribing bass tab...")
        try:
            notes = _transcribe_bass(stem_paths["bass"])
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
        "bassTab":     bass_tab_written,
    }
