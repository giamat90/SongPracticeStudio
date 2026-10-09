"""Synthetic audio for the sidecar tests: known pitch, level and spectrum."""

import numpy as np
import soundfile as sf


def sine(freq, sr, seconds, amp=0.5):
    t = np.arange(int(sr * seconds)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


def harmonic_tone(f0, sr, seconds, amp=0.4, n_harmonics=8, rolloff=0.7):
    """A voice-like source: f0 plus decaying harmonics, peak-normalised to `amp`."""
    t = np.arange(int(sr * seconds)) / sr
    x = np.zeros_like(t)
    for k in range(1, n_harmonics + 1):
        if k * f0 < sr / 2:
            x += (rolloff ** (k - 1)) * np.sin(2 * np.pi * k * f0 * t)
    x = x / np.max(np.abs(x)) * amp
    return x.astype(np.float32)


def glide(f_start, f_end, sr, seconds, amp=0.4, n_harmonics=6):
    n = int(sr * seconds)
    f = np.linspace(f_start, f_end, n)
    phase = 2 * np.pi * np.cumsum(f) / sr
    x = sum((0.7 ** (k - 1)) * np.sin(k * phase) for k in range(1, n_harmonics + 1))
    return (x / np.max(np.abs(x)) * amp).astype(np.float32)


def vibrato_tone(f0, sr, seconds, rate_hz=5.5, depth_cents=50, amp=0.4):
    n = int(sr * seconds)
    t = np.arange(n) / sr
    f = f0 * 2 ** ((depth_cents * np.sin(2 * np.pi * rate_hz * t)) / 1200)
    phase = 2 * np.pi * np.cumsum(f) / sr
    x = sum((0.7 ** (k - 1)) * np.sin(k * phase) for k in range(1, 6))
    return (x / np.max(np.abs(x)) * amp).astype(np.float32)


def white_noise(sr, seconds, amp=0.3, seed=0):
    rng = np.random.default_rng(seed)
    return (amp * (rng.random(int(sr * seconds)) * 2 - 1)).astype(np.float32)


def write_wav(path, audio, sr):
    sf.write(str(path), audio, sr, subtype="PCM_16", format="WAV")
    return str(path)


def voiced_median(result):
    f0 = np.array(result["f0"])
    voiced = np.array(result["voiced"], dtype=bool)
    return float(np.median(f0[voiced])) if voiced.any() else float("nan")


def cents(a, b):
    return 1200 * np.log2(a / b)


def rms_db(x):
    r = np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2))
    return 20 * np.log10(r) if r > 0 else -120.0
