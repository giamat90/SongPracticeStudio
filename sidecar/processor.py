"""
Core processing pipeline for Song Analyzer.
Demucs htdemucs_6s stem separation → BPM → key detection.
"""

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


def process(input_path: str, output_dir: str, on_progress=None) -> dict:
    """Full pipeline: separate all stems, detect BPM and key."""
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)

    # ===================================================================
    # Stage 1: Demucs htdemucs_6s separation (0.00 – 0.75)
    # ===================================================================
    on_progress(0.0, "stem-separation")
    _log("Loading Demucs model (htdemucs_6s)...")

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = get_model("htdemucs_6s")
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
    on_progress(0.72, "stem-separation")

    stem_paths = {}
    for i, name in enumerate(model.sources):
        stem_tensor = sources[i] * ref.std() + ref.mean()
        path = os.path.join(output_dir, f"{name}.wav")
        sf.write(path, stem_tensor.numpy().T, model.samplerate)
        stem_paths[name] = path
        _log(f"Wrote {name}.wav")

    on_progress(0.78, "stem-separation")

    # Duration from the first stem file (fast metadata read)
    first_stem_path = next(iter(stem_paths.values()))
    duration = librosa.get_duration(path=first_stem_path)

    _log("Freeing Demucs from memory...")
    del model, sources, wav, ref
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # ===================================================================
    # Stage 2: BPM detection (0.78 – 0.90)
    # ===================================================================
    on_progress(0.78, "bpm-detection")
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
    on_progress(0.90, "bpm-detection")

    # ===================================================================
    # Stage 3: Key detection (0.90 – 1.00)
    # ===================================================================
    on_progress(0.90, "key-detection")
    _log("Detecting key...")
    detected_key = _detect_key_chroma(input_path)
    on_progress(1.0, "complete")
    _log("Processing complete.")

    return {
        "stems": {name: str(p) for name, p in stem_paths.items()},
        "duration": duration,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
    }
