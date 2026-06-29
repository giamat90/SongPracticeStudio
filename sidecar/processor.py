"""
Core processing pipeline for Song Analyzer.
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
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 22050

MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

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

    try:
        import crepe
        _log("Running CREPE pitch tracking (medium)...")
        time_arr, freq_arr, conf_arr, _ = crepe.predict(
            y, sr, model_capacity='medium', viterbi=True, step_size=10, verbose=0,
        )
        voiced_flag = conf_arr >= 0.5
        f0, times, frame_dur = freq_arr, time_arr, 0.010

        def _midi_float(f):
            return 12.0 * np.log2(f / 440.0) + 69.0

    except Exception as e:
        _log(f"CREPE unavailable, falling back to pyin: {e}")
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
    # Stage 4: Bass tab transcription (0.92 – 1.00)
    # ===================================================================
    on_progress(0.92, "bass-tab")
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
        "bassTab":     bass_tab_written,
    }
