"""
Core processing pipeline for uploaded songs.
Demucs stem separation → pyin pitch → librosa onsets/dynamics/BPM → key detection.
"""

import os
import sys
import gc
import time
import traceback
import numpy as np
import soundfile as sf
import librosa
from scipy.signal import butter, sosfilt, resample_poly
from scipy.ndimage import median_filter, gaussian_filter1d

SAMPLE_RATE = 44100
CONFIDENCE_THRESHOLD = 0.5

# Krumhansl-Kessler key profiles
MAJOR_PROFILE = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR_PROFILE = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _log(msg: str):
    print(msg, file=sys.stderr, flush=True)


def _correct_octave_errors_spectral(
    y: np.ndarray,
    sr: int,
    f0: np.ndarray,
    voiced_flag: np.ndarray,
    hop_length: int = 512,
    n_fft: int = 2048,
    fmin_hz: float = 65.0,
) -> np.ndarray:
    """
    Spectral subharmonic check for octave errors.

    When pyin locks onto 2F0 instead of F0 (common on powerful high notes),
    the true fundamental F0 = detected/2 is still present in the spectrum,
    along with its 3rd harmonic at 3·F0/2.  A correctly detected F0 has no
    energy at F0/2 (singing voice has no subharmonics).

    This check is per-frame and independent of neighbours, so sustained
    octave errors (where the local median is also wrong) are caught.
    """
    D = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop_length))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    corrected = f0.copy()
    n = min(len(f0), D.shape[1])

    def energy_near(freq: float, frame: int) -> float:
        # Sum energy within ±1 semitone of freq
        lo = freq * 2 ** (-1 / 12)
        hi = freq * 2 ** (1 / 12)
        mask = (freqs >= lo) & (freqs <= hi)
        return float(D[mask, frame].sum()) if mask.any() else 0.0

    for i in range(n):
        if not voiced_flag[i] or np.isnan(f0[i]) or f0[i] <= 0:
            continue
        f_sub = f0[i] / 2.0
        if f_sub < fmin_hz:
            continue

        e_det  = energy_near(f0[i],         i)
        e_sub  = energy_near(f_sub,          i)   # candidate true F0
        e_3sub = energy_near(3.0 * f_sub,    i)   # 3rd harmonic of candidate F0

        # Subharmonic AND its odd harmonic present → detected pitch is 2F0, not F0
        if e_sub > 0.2 * e_det and e_3sub > 0.1 * e_det:
            corrected[i] = f_sub

    return corrected


def detect_pitch(audio: np.ndarray, sr: int) -> dict:
    """
    Deterministic pitch detection using pYIN + spectral subharmonic correction.
    pYIN is autocorrelation-based and robust to strong harmonics; the spectral
    correction adds a second-pass octave check for edge cases.
    """
    f0, voiced_flag, voiced_probs = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz('C2'),
        fmax=librosa.note_to_hz('C7'),
        sr=sr,
        frame_length=2048,
        hop_length=512,
        beta_parameters=(2, 6),
    )
    f0 = _correct_octave_errors_spectral(audio, sr, f0, voiced_flag)
    times = librosa.times_like(f0, sr=sr, hop_length=512)
    f0_clean = np.where(voiced_flag, f0, 0.0)
    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced_flag.tolist(),
        "confidence": voiced_probs.tolist(),
    }


def detect_pitch_srh(audio: np.ndarray, sr: int) -> dict:
    """
    Summation of Residual Harmonics (SRH) pitch detection.

    For each candidate F0, SRH sums spectral energy at harmonics
    and subtracts energy at inter-harmonic frequencies:

        SRH(f) = sum_n [ X(n*f) - X((n+0.5)*f) ]  for n = 1..N

    The true F0 maximizes this score. More stable than HPS because:
    - Addition is robust to weak/missing harmonics (HPS multiplication is not)
    - Inter-harmonic subtraction actively suppresses non-fundamental candidates
    - Sub-bin precision via parabolic interpolation on the SRH score curve
    """

    # Resample to 22050 Hz for consistent bin resolution
    # Demucs outputs 44100 — halving gives 5.4 Hz/bin at frame_length=4096
    target_sr = 22050
    if sr != target_sr:
        audio = librosa.resample(audio, orig_sr=sr, target_sr=target_sr)
        sr = target_sr

    frame_length = 4096
    hop_length = 512
    n_harmonics = 5
    fmin = librosa.note_to_hz('C2')   # ~65 Hz
    fmax = librosa.note_to_hz('C7')   # ~2093 Hz
    voicing_threshold = 0.15

    # Pad audio
    audio = np.pad(audio, frame_length // 2, mode='reflect')
    frames = librosa.util.frame(
        audio,
        frame_length=frame_length,
        hop_length=hop_length
    )
    n_frames = frames.shape[1]

    # Frequency axis
    freqs = np.fft.rfftfreq(frame_length, d=1.0 / sr)
    bin_width = sr / frame_length  # Hz per bin

    # Candidate F0 range — evaluate SRH at each candidate
    # Use fine resolution: 0.5 Hz steps for sub-Hz precision
    f0_candidates = np.arange(fmin, fmax, 0.5)

    # Precompute candidate bin indices for harmonics and inter-harmonics
    # Shape: (n_candidates, n_harmonics)
    harmonic_bins = np.array([
        np.round(f0_candidates * n / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T  # (n_candidates, n_harmonics)

    inter_bins = np.array([
        np.round(f0_candidates * (n + 0.5) / bin_width).astype(int)
        for n in range(1, n_harmonics + 1)
    ]).T  # (n_candidates, n_harmonics)

    # Clip to valid spectrum range
    max_bin = len(freqs) - 1
    harmonic_bins = np.clip(harmonic_bins, 0, max_bin)
    inter_bins = np.clip(inter_bins, 0, max_bin)

    f0 = np.zeros(n_frames)
    confidence = np.zeros(n_frames)

    for i in range(n_frames):
        frame = frames[:, i] * np.hanning(frame_length)
        spectrum = np.abs(np.fft.rfft(frame))

        # Normalize spectrum
        spectrum = spectrum / (spectrum.max() + 1e-8)

        # Compute SRH score for each candidate
        # SRH(f) = sum_n [ X(n*f) - X((n+0.5)*f) ]
        harmonic_energy = spectrum[harmonic_bins].sum(axis=1)
        inter_energy = spectrum[inter_bins].sum(axis=1)
        srh_scores = harmonic_energy - inter_energy

        # Find best candidate
        best_idx = np.argmax(srh_scores)
        best_score = srh_scores[best_idx]

        # Parabolic interpolation on SRH score curve for sub-Hz precision
        if 0 < best_idx < len(srh_scores) - 1:
            alpha = srh_scores[best_idx - 1]
            beta  = srh_scores[best_idx]
            gamma = srh_scores[best_idx + 1]
            denom = (alpha - 2 * beta + gamma)
            if denom != 0:
                p = 0.5 * (alpha - gamma) / denom
                p = np.clip(p, -1.0, 1.0)
            else:
                p = 0.0
        else:
            p = 0.0

        # Final F0: candidate frequency + sub-bin offset (0.5 Hz steps)
        f0[i] = f0_candidates[best_idx] + p * 0.5
        confidence[i] = best_score

    # Normalize confidence to 0-1
    if confidence.max() > 0:
        confidence = confidence / confidence.max()

    # Voicing detection
    voiced = confidence > voicing_threshold
    f0_clean = np.where(voiced, f0, 0.0)

    # Post-processing smoothing on voiced frames only
    f0_smooth = f0_clean.copy()
    voiced_indices = np.where(voiced)[0]

    if len(voiced_indices) > 3:
        f0_smooth[voiced_indices] = median_filter(
            f0_clean[voiced_indices],
            size=3  # lighter than before — SRH is already more stable
        )
        f0_smooth[voiced_indices] = gaussian_filter1d(
            f0_smooth[voiced_indices],
            sigma=1.0  # lighter sigma — preserve real pitch movement
        )

    f0_clean = f0_smooth

    # Time axis
    times = librosa.frames_to_time(
        np.arange(n_frames), sr=sr, hop_length=hop_length
    )

    return {
        "times": times.tolist(),
        "f0": f0_clean.tolist(),
        "voiced": voiced.tolist(),
        "confidence": confidence.tolist()
    }


def _detect_key(pitch_hz: np.ndarray, confidence: np.ndarray) -> str:
    valid = (confidence >= CONFIDENCE_THRESHOLD) & (pitch_hz > 0)
    freqs = pitch_hz[valid]
    if len(freqs) < 50:
        return "Unknown"

    midi = 69 + 12 * np.log2(freqs / 440.0)
    pitch_classes = np.round(midi).astype(int) % 12
    histogram = np.bincount(pitch_classes, minlength=12).astype(float)
    histogram /= histogram.sum() + 1e-9

    best_score = -np.inf
    best_key = "C major"
    for shift in range(12):
        rotated = np.roll(histogram, -shift)
        maj_score = np.corrcoef(rotated, MAJOR_PROFILE)[0, 1]
        min_score = np.corrcoef(rotated, MINOR_PROFILE)[0, 1]
        if maj_score > best_score:
            best_score = maj_score
            best_key = f"{NOTE_NAMES[shift]} major"
        if min_score > best_score:
            best_score = min_score
            best_key = f"{NOTE_NAMES[shift]} minor"

    return best_key


def process(input_path: str, output_dir: str, on_progress=None) -> dict:
    """Full processing pipeline for an uploaded song."""
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)

    # ===================================================================
    # Stage 1: Demucs stem separation (0.00 – 0.50)
    # ===================================================================
    on_progress(0.0, "stem-separation")
    _log("Loading Demucs model...")

    import torch
    from demucs.pretrained import get_model
    from demucs.apply import apply_model
    from demucs.audio import AudioFile

    model = get_model("htdemucs")
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
    on_progress(0.45, "stem-separation")

    source_names = model.sources
    vocals_idx = source_names.index("vocals")
    vocals_tensor = sources[vocals_idx]
    instrumental_tensor = sum(
        sources[i] for i in range(len(source_names)) if i != vocals_idx
    )

    vocals_tensor = vocals_tensor * ref.std() + ref.mean()
    instrumental_tensor = instrumental_tensor * ref.std() + ref.mean()

    vocals_path = os.path.join(output_dir, "vocals.wav")
    instrumental_path = os.path.join(output_dir, "instrumental.wav")
    sf.write(vocals_path, vocals_tensor.numpy().T, model.samplerate)
    sf.write(instrumental_path, instrumental_tensor.numpy().T, model.samplerate)
    on_progress(0.50, "stem-separation")

    _log("Freeing Demucs from memory...")
    del model, sources, wav, ref, vocals_tensor, instrumental_tensor
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    # ===================================================================
    # Stage 2: pyin pitch extraction (0.50 – 0.70)
    # ===================================================================
    on_progress(0.50, "pitch-extraction")
    _log("Running pitch detection (SRH)...")

    pitch_result = {"times": [], "f0": [], "voiced": [], "confidence": []}

    try:
        vocals_mono, sr_pyin = librosa.load(vocals_path, sr=22050, mono=True)
        pitch_result = detect_pitch_srh(vocals_mono, sr_pyin)
        n_voiced = sum(pitch_result["voiced"])
        _log(f"Pitch detection complete: {n_voiced} voiced frames")

    except Exception as e:
        _log(f"pyin error: {e}\n{traceback.format_exc()}")

    on_progress(0.70, "pitch-extraction")
    gc.collect()

    # ===================================================================
    # Stage 3: Onset detection (0.70 – 0.82)
    # ===================================================================
    on_progress(0.70, "onset-detection")
    _log("Detecting onsets...")

    vocals_lr, sr_lr = librosa.load(vocals_path, sr=SAMPLE_RATE, mono=True)
    onset_frames = librosa.onset.onset_detect(y=vocals_lr, sr=sr_lr, units="frames")
    onsets = librosa.frames_to_time(onset_frames, sr=sr_lr).tolist()
    onsets = [round(t, 4) for t in onsets]
    on_progress(0.82, "onset-detection")

    # ===================================================================
    # Stage 4: Dynamics / RMS (0.82 – 0.88)
    # ===================================================================
    on_progress(0.82, "dynamics")
    _log("Computing dynamics...")

    rms = librosa.feature.rms(y=vocals_lr)[0]
    rms_times = librosa.frames_to_time(np.arange(len(rms)), sr=sr_lr)
    dynamics = [
        {"time": round(float(rms_times[i]), 4), "rms": round(float(rms[i]), 6)}
        for i in range(len(rms))
    ]
    on_progress(0.88, "dynamics")

    # ===================================================================
    # Stage 5: BPM detection (0.88 – 0.93)
    # ===================================================================
    on_progress(0.88, "bpm-detection")
    _log("Estimating BPM...")

    full_mix, sr_full = librosa.load(input_path, sr=SAMPLE_RATE, mono=True)
    tempo = librosa.beat.tempo(y=full_mix, sr=sr_full)
    detected_bpm = round(float(tempo[0]), 1) if len(tempo) > 0 else None
    on_progress(0.93, "bpm-detection")

    del full_mix, vocals_lr
    gc.collect()

    # ===================================================================
    # Stage 6: Key detection (0.93 – 1.0)
    # ===================================================================
    on_progress(0.93, "key-detection")
    _log("Detecting key...")

    if any(pitch_result["voiced"]):
        detected_key = _detect_key(
            np.array(pitch_result["f0"]),
            np.array(pitch_result["confidence"]),
        )
    else:
        detected_key = "Unknown"

    on_progress(1.0, "complete")
    _log("Processing complete.")

    return {
        "vocals": vocals_path,
        "instrumental": instrumental_path,
        "pitchData": pitch_result,
        "onsets": onsets,
        "dynamics": dynamics,
        "detectedBpm": detected_bpm,
        "detectedKey": detected_key,
    }


def pitch_shift_song(song_dir: str, cache_dir: str, n_steps: float, on_progress=None):
    """Pitch-shift vocals.wav and instrumental.wav by n_steps semitones.

    Results are written to cache_dir/vocals.wav and cache_dir/instrumental.wav.
    Uses the phase vocoder so tempo is preserved.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    tracks = ["vocals.wav", "instrumental.wav"]
    paths = {}

    for i, name in enumerate(tracks):
        input_path = os.path.join(song_dir, name)
        output_path = os.path.join(cache_dir, name)

        on_progress(i / len(tracks), f"loading-{name}")
        audio, sr = librosa.load(input_path, sr=None, mono=False)

        on_progress((i + 0.5) / len(tracks), f"shifting-{name}")
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
    return {
        "vocalsPath": paths["vocals.wav"],
        "instrumentalPath": paths["instrumental.wav"],
    }
