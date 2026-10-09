"""
Take (recorded track) file handling for Song Practice Studio.
No pitch/vocal analysis — recording is saved as-is; this module only
handles format conversion for export and loudness normalization.
"""

import os
import numpy as np
import soundfile as sf
import librosa

SAMPLE_RATE = 44100

# Raw mic takes have far more dynamic range than a mastered/limited commercial
# mix, so matching peak level alone still leaves takes sounding quiet next to
# the separated stems. Match RMS (average loudness) to a reference stem
# instead, capped so we never push peaks past PEAK_CEILING_DBFS.
TARGET_RMS_DBFS_FALLBACK = -18.0  # used when no reference stem is available
PEAK_CEILING_DBFS = -1.0


def _rms_dbfs(samples: np.ndarray) -> float:
    if samples.size == 0:
        return -120.0
    rms = np.sqrt(np.mean(samples.astype(np.float64) ** 2))
    return 20 * np.log10(rms) if rms > 0 else -120.0


def normalize_take(recording_path: str, output_path: str, reference_path: str = None, audio_offset_s: float = 0.0) -> dict:
    """
    RMS-normalize a recorded take against a reference stem (e.g. vocals.wav)
    so it doesn't sound quiet next to the other stems at unity volume.
    Falls back to a fixed target loudness when no reference stem exists.
    """
    take_audio, take_sr = librosa.load(recording_path, sr=None, mono=True)
    # Loudness is judged on the audible part only, but the whole file is written
    # back: the player skips `audio_offset_s` into it itself, so trimming it here
    # would skip that much twice.
    audible = take_audio[min(len(take_audio), int(round(audio_offset_s * take_sr))):]
    take_rms_db = _rms_dbfs(audible)
    take_peak = float(np.max(np.abs(take_audio))) if take_audio.size else 0.0

    if reference_path and os.path.exists(reference_path):
        ref_audio, _ = librosa.load(reference_path, sr=take_sr, mono=True)
        target_rms_db = _rms_dbfs(ref_audio)
    else:
        target_rms_db = TARGET_RMS_DBFS_FALLBACK

    gain_linear = 10 ** ((target_rms_db - take_rms_db) / 20)
    if take_peak > 0:
        max_safe_gain = 10 ** (PEAK_CEILING_DBFS / 20) / take_peak
        gain_linear = min(gain_linear, max_safe_gain)

    sf.write(output_path, take_audio * gain_linear, take_sr)
    return {"path": output_path, "appliedGainDb": round(20 * np.log10(gain_linear), 2) if gain_linear > 0 else 0.0}


def convert_take_to_wav(recording_path: str, output_path: str) -> dict:
    """
    Decode a take (typically .webm/opus) to PCM and write it out as WAV
    for export. Keeps the file's native sample rate and channel count.
    """
    audio, sr = librosa.load(recording_path, sr=None, mono=False)
    data = audio.T if audio.ndim > 1 else audio
    sf.write(output_path, data, sr)
    return {"path": output_path}


def _probe_source(path: str) -> tuple:
    """
    Returns (duration_sec, sample_rate, full_samples_or_None). For plain WAV
    files, soundfile.info() gives an instant, reliable duration and we defer
    decoding to an offset-based partial read. For anything soundfile can't
    parse (e.g. a take's .webm/opus), `librosa.get_duration(path=...)` is
    unreliable — it silently returns 0 for at least some real Opus-in-WebM
    recordings — so decode the whole file up front instead and slice it
    in memory; this is what already happens in `convert_take_to_wav`.
    """
    try:
        info = sf.info(path)
        return info.frames / info.samplerate, info.samplerate, None
    except Exception:
        audio, sr = librosa.load(path, sr=None, mono=False)
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        samples = audio.T  # (n, channels)
        return samples.shape[0] / sr, sr, samples


def _load_source_slice(source: dict, start_sec: float, end_sec: float) -> tuple:
    """
    Decode the portion of `source` that falls within [start_sec, end_sec) of
    the *project* timeline, returning (samples, sr) already padded/truncated
    to exactly (end_sec - start_sec) seconds. `samples` is shape (n, channels).
    """
    path = source["path"]
    window_len = end_sec - start_sec

    # The first `audio_offset` seconds of a take's file are latency padding that
    # playback skips, so the file only becomes audible from that point on.
    first_audible = 0.0
    if source.get("isTake"):
        # fileTime = projectTime - (startPosition + manualOffset) + audioOffset (see player.ts).
        start_position = float(source.get("startPosition", 0.0))
        manual_offset = float(source.get("manualOffset", 0.0))
        audio_offset = float(source.get("audioOffset", 0.0))
        effective_start = start_position + manual_offset
        file_start = start_sec - effective_start + audio_offset
        file_end = end_sec - effective_start + audio_offset
        first_audible = audio_offset
    else:
        file_start = start_sec
        file_end = end_sec

    duration, sr, full_samples = _probe_source(path)
    clipped_start = max(first_audible, file_start)
    clipped_end = min(duration, file_end)

    if clipped_end <= clipped_start:
        # Requested window doesn't overlap this source's file at all — silence.
        return None, None

    if full_samples is not None:
        start_idx = int(round(clipped_start * sr))
        end_idx = int(round(clipped_end * sr))
        samples = full_samples[start_idx:end_idx]
    else:
        audio, sr = librosa.load(
            path, sr=None, mono=False,
            offset=clipped_start, duration=clipped_end - clipped_start,
        )
        if audio.ndim == 1:
            audio = audio[np.newaxis, :]
        samples = audio.T  # (n, channels)

    # Position this slice within the full window: the part of the window that
    # precedes the source's first audible sample is silence.
    lead_silence = clipped_start - file_start
    lead_samples = int(round(lead_silence * sr))
    target_samples = int(round(window_len * sr))

    if samples.shape[1] == 1:
        samples = np.repeat(samples, 2, axis=1)

    out = np.zeros((target_samples, samples.shape[1]), dtype=np.float32)
    n = min(samples.shape[0], target_samples - lead_samples)
    if n > 0:
        out[lead_samples:lead_samples + n] = samples[:n]
    return out, sr


def mix_export(sources: list, start_sec: float, end_sec: float, output_path: str) -> dict:
    """
    Render a single WAV mixdown from `sources` (each {path, gain, isTake,
    startPosition?, audioOffset?}), trimmed to [start_sec, end_sec) of the
    project timeline, summing per-source gain. Mute/solo has already been
    resolved to a final linear gain by the caller — sources with gain 0
    should already be omitted, but any included source is still mixed in.
    """
    if not sources:
        raise ValueError("mix_export requires at least one source")

    target_sr = None
    channels = 2
    mixed = None

    for source in sources:
        samples, sr = _load_source_slice(source, start_sec, end_sec)
        if samples is None:
            continue

        if target_sr is None:
            target_sr = sr
        elif sr != target_sr:
            samples = librosa.resample(samples.T, orig_sr=sr, target_sr=target_sr).T

        gained = samples * float(source["gain"])
        if mixed is None:
            mixed = gained
        else:
            # Sources can differ in sample count by a rounding error after
            # resampling — trim to the shorter one rather than crash.
            n = min(mixed.shape[0], gained.shape[0])
            mixed = mixed[:n] + gained[:n]

    if mixed is None or target_sr is None:
        # None of the sources overlapped the requested window at all.
        target_samples = int(round((end_sec - start_sec) * SAMPLE_RATE))
        mixed = np.zeros((target_samples, channels), dtype=np.float32)
        target_sr = SAMPLE_RATE

    peak = float(np.max(np.abs(mixed))) if mixed.size else 0.0
    if peak > 1.0:
        mixed = mixed / peak

    sf.write(output_path, mixed, target_sr)
    return {"path": output_path}
