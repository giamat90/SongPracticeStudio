"""
Analyze a user's vocal recording (take).
Uses SRH pitch detection — spectral, avoids locking onto the second formant.
"""

import sys
import numpy as np
import librosa
from processor import detect_pitch_srh

SAMPLE_RATE = 44100
CONFIDENCE_THRESHOLD = 0.5
SRH_SR = 22050
SRH_HOP = 512
STEP_MS = SRH_HOP / SRH_SR * 1000   # ≈ 23.2 ms per frame


def _detect_vibrato(frequency: np.ndarray, confidence: np.ndarray, step_ms: float) -> dict:
    """
    Estimate vibrato rate, depth, and regularity from a pitch contour.
    Vibrato is a quasi-periodic modulation of pitch, typically 4–8 Hz with 20–200 cent depth.
    """
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (frequency > 0)
    if valid.sum() < 100:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    freqs = frequency.copy()
    freqs[~valid] = np.nan

    nans = np.isnan(freqs)
    if nans.all():
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    x = np.arange(len(freqs))
    freqs[nans] = np.interp(x[nans], x[~nans], freqs[~nans])

    mean_pitch = np.nanmean(freqs)
    cents = 1200 * np.log2(freqs / mean_pitch + 1e-9)

    from scipy.ndimage import uniform_filter1d
    window = max(3, int(500 / step_ms))
    smoothed = uniform_filter1d(cents, size=window)
    detrended = cents - smoothed

    step_sec = step_ms / 1000.0
    fs = 1.0 / step_sec
    min_lag = int(fs / 8.0)
    max_lag = int(fs / 4.0)

    if max_lag <= min_lag or max_lag >= len(detrended) // 2:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    autocorr = np.correlate(detrended, detrended, mode="full")
    autocorr = autocorr[len(detrended) - 1:]
    autocorr /= autocorr[0] + 1e-9

    search_region = autocorr[min_lag:max_lag + 1]
    if len(search_region) == 0:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    peak_idx = np.argmax(search_region)
    peak_lag = min_lag + peak_idx
    peak_val = search_region[peak_idx]

    rate = fs / peak_lag if peak_lag > 0 else 0.0
    depth = float(np.std(detrended) * 2)
    regularity = max(0.0, min(1.0, float(peak_val)))

    if depth < 10 or regularity < 0.15:
        return {"rate": 0.0, "depth": 0.0, "regularity": 0.0}

    return {
        "rate": round(rate, 2),
        "depth": round(depth, 1),
        "regularity": round(regularity, 3),
    }


def analyze_recording(recording_path: str, output_dir=None, on_progress=None) -> dict:
    """
    Analyze a vocal recording (user take).

    Returns dict with pitchData (parallel arrays), onsets, dynamics, vibrato.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    # --- Stage 1: SRH pitch extraction (0.0 – 0.50) ---
    on_progress(0.0, "pitch-extraction")
    print("Running SRH pitch extraction on recording...", file=sys.stderr)

    audio, sr = librosa.load(recording_path, sr=SRH_SR, mono=True)
    pitch_result = detect_pitch_srh(audio, sr)
    n_voiced = sum(pitch_result["voiced"])
    print(f"Pitch detection complete: {n_voiced} voiced frames", file=sys.stderr)
    on_progress(0.50, "pitch-extraction")

    # --- Stage 2: Onset detection (0.50 – 0.70) ---
    on_progress(0.60, "onset-detection")
    print("Detecting onsets...", file=sys.stderr)

    audio_lr, sr_lr = librosa.load(recording_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=audio_lr, sr=sr_lr, units="frames")
    onsets = [round(t, 4) for t in librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()]
    on_progress(0.70, "onset-detection")

    # --- Stage 3: Dynamics / RMS (0.70 – 0.85) ---
    on_progress(0.80, "dynamics")
    print("Computing dynamics...", file=sys.stderr)

    rms = librosa.feature.rms(y=audio_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = [
        {"time": round(float(rms_times[i]), 4), "rms": round(float(rms[i]), 6)}
        for i in range(len(rms))
    ]
    on_progress(0.85, "dynamics")

    # --- Stage 4: Vibrato detection (0.85 – 1.0) ---
    on_progress(0.90, "vibrato-detection")
    print("Analyzing vibrato...", file=sys.stderr)

    vibrato = _detect_vibrato(
        np.array(pitch_result["f0"]),
        np.array(pitch_result["confidence"]),
        STEP_MS,
    )
    on_progress(1.0, "complete")

    return {
        "pitchData": pitch_result,
        "onsets": onsets,
        "dynamics": dynamics,
        "vibrato": vibrato,
    }
