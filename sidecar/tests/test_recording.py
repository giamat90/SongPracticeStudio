import shutil
import subprocess

import numpy as np
import pytest
import soundfile as sf

import recording
from helpers import harmonic_tone, rms_db, sine, write_wav


class TestConvertTake:
    def test_writes_a_wav_with_the_native_rate_and_channels(self, tmp_path):
        stereo = np.stack([sine(300, 32000, 1.0), sine(500, 32000, 1.0)], axis=1)
        src = tmp_path / "in.wav"
        sf.write(str(src), stereo, 32000)
        out = tmp_path / "out.wav"
        assert recording.convert_take_to_wav(str(src), str(out)) == {"path": str(out)}
        data, sr = sf.read(str(out))
        assert sr == 32000 and data.shape == stereo.shape

    def test_mono_stays_mono(self, tmp_path):
        src = write_wav(tmp_path / "in.wav", sine(300, 22050, 0.5), 22050)
        out = tmp_path / "out.wav"
        recording.convert_take_to_wav(src, str(out))
        data, _ = sf.read(str(out))
        assert data.ndim == 1

    def test_missing_input_raises(self, tmp_path):
        with pytest.raises(Exception):
            recording.convert_take_to_wav(str(tmp_path / "missing.webm"), str(tmp_path / "o.wav"))

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg to author a webm/opus take")
    def test_decodes_a_real_webm_opus_take(self, tmp_path):
        wav = write_wav(tmp_path / "src.wav", sine(440, 48000, 1.0), 48000)
        webm = tmp_path / "take.webm"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", str(webm)], check=True)
        out = tmp_path / "out.wav"
        recording.convert_take_to_wav(str(webm), str(out))
        data, sr = sf.read(str(out))
        assert sr == 48000 and abs(len(data) / sr - 1.0) < 0.1


def const_wav(path, value, seconds, sr, channels=1):
    x = np.full((int(seconds * sr), channels) if channels > 1 else int(seconds * sr), value, dtype=np.float32)
    sf.write(str(path), x, sr, subtype="FLOAT")
    return str(path)


def ramp_wav(path, seconds, sr):
    """Sample value = file time / 10, so any output sample reveals which file time landed there."""
    t = np.arange(int(seconds * sr)) / sr
    sf.write(str(path), (t / 10).astype(np.float32), sr, subtype="FLOAT")
    return str(path)


def read(path):
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    return data, sr


def at(data, sr, project_seconds, window_start):
    return float(data[int(round((project_seconds - window_start) * sr)), 0])


class TestMixExport:
    SR = 8000

    def test_requires_at_least_one_source(self, tmp_path):
        with pytest.raises(ValueError):
            recording.mix_export([], 0, 1, str(tmp_path / "o.wav"))

    def test_a_plain_stem_is_trimmed_to_the_window_and_made_stereo(self, tmp_path):
        p = const_wav(tmp_path / "a.wav", 0.3, 10, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": p, "gain": 1.0, "isTake": False}], 2.0, 6.0, str(out))
        data, sr = read(out)
        assert sr == self.SR
        assert data.shape == (4 * self.SR, 2)
        assert np.allclose(data, 0.3, atol=1e-4)

    def test_applies_each_sources_gain_and_sums(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.2, 3, self.SR)
        b = const_wav(tmp_path / "b.wav", 0.4, 3, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export(
            [{"path": a, "gain": 0.5, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 2, str(out)
        )
        data, _ = read(out)
        assert np.allclose(data, 0.5, atol=1e-4)

    def test_scales_down_instead_of_clipping(self, tmp_path):
        """Clipping would flatten the 1.5 peaks to 1.0; scaling keeps the 1.5 : 1.0 relationship."""
        loud = np.tile(np.array([1.0, 0.5], dtype=np.float32), self.SR)
        a = tmp_path / "a.wav"
        sf.write(str(a), loud, self.SR, subtype="FLOAT")
        b = const_wav(tmp_path / "b.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": str(a), "gain": 1.0, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 1, str(out))
        data, _ = read(out)
        hi, lo = float(data[0, 0]), float(data[1, 0])
        assert hi == pytest.approx(1.0, abs=2e-3)
        assert lo == pytest.approx(1.0 / 1.5, abs=2e-3)

    def test_leaves_a_quiet_mix_untouched(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.1, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 0, 1, str(out))
        assert np.allclose(read(out)[0], 0.1, atol=1e-4)

    def test_a_stereo_source_keeps_its_channels(self, tmp_path):
        x = np.stack([np.full(2 * self.SR, 0.1), np.full(2 * self.SR, 0.6)], axis=1).astype(np.float32)
        p = tmp_path / "s.wav"
        sf.write(str(p), x, self.SR, subtype="FLOAT")
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": str(p), "gain": 1.0, "isTake": False}], 0, 1, str(out))
        data, _ = read(out)
        assert np.allclose(data[:, 0], 0.1, atol=1e-4) and np.allclose(data[:, 1], 0.6, atol=1e-4)

    def test_resamples_a_source_with_a_different_rate_to_the_first_sources_rate(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.2, 3, 8000)
        b = const_wav(tmp_path / "b.wav", 0.3, 3, 16000)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": a, "gain": 1.0, "isTake": False}, {"path": b, "gain": 1.0, "isTake": False}], 0, 2, str(out))
        data, sr = read(out)
        assert sr == 8000
        assert abs(len(data) - 2 * 8000) <= 8
        assert np.allclose(data[200:-200], 0.5, atol=0.02)

    def test_a_window_with_no_overlap_renders_silence_of_the_requested_length(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 5, 7, str(out))
        data, sr = read(out)
        assert sr == 44100 and data.shape == (2 * 44100, 2)
        assert not data.any()

    def test_a_window_running_past_the_end_is_padded_with_silence(self, tmp_path):
        a = const_wav(tmp_path / "a.wav", 0.5, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": a, "gain": 1.0, "isTake": False}], 1, 4, str(out))
        data, _ = read(out)
        assert data.shape[0] == 3 * self.SR
        assert np.allclose(data[: self.SR], 0.5, atol=1e-4)
        assert not data[self.SR + 100 :].any()

    # ── take alignment ────────────────────────────────────────────────────

    def take(self, path, **kw):
        return {"path": path, "gain": 1.0, "isTake": True, **kw}

    def test_a_take_starting_inside_the_window_is_preceded_by_silence(self, tmp_path):
        """Project time 4 s is where the take begins; the export must not slide it to the window start."""
        p = const_wav(tmp_path / "t.wav", 0.5, 3, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=4.0)], 2.0, 8.0, str(out))
        data, sr = read(out)
        assert data.shape[0] == 6 * sr
        assert not data[: 2 * sr - 50].any(), "silence from 2 s to 4 s"
        assert np.allclose(data[2 * sr + 50 : 5 * sr - 50], 0.5, atol=1e-4), "take plays 4 s - 7 s"
        assert not data[5 * sr + 50 :].any(), "silence from 7 s to 8 s"

    def test_a_take_content_lands_at_the_matching_project_time(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=3.0)], 0.0, 10.0, str(out))
        data, sr = read(out)
        for project_t in (3.5, 4.0, 6.0):
            assert at(data, sr, project_t, 0.0) == pytest.approx((project_t - 3.0) / 10, abs=2e-3)

    def test_a_take_that_began_before_the_window_is_cut_into(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 8, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=1.0)], 4.0, 6.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 4.0) == pytest.approx((4.5 - 1.0) / 10, abs=2e-3)

    def test_audio_offset_skips_the_start_of_the_file_and_never_plays_it_early(self, tmp_path):
        """Latency compensation: file time `audioOffset` is what plays at `startPosition`."""
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=4.0, audioOffset=0.5)], 2.0, 8.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 2.0) == pytest.approx((4.5 - 4.0 + 0.5) / 10, abs=2e-3)
        assert not data[: 2 * sr - 50].any()
        assert abs(at(data, sr, 3.9, 2.0)) < 1e-6, "the skipped first 0.5 s of the file must not leak before the take starts"

    def test_manual_offset_shifts_the_take(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=3.0, manualOffset=1.5)], 0.0, 10.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 5.0, 0.0) == pytest.approx((5.0 - 4.5) / 10, abs=2e-3)
        assert abs(at(data, sr, 4.0, 0.0)) < 1e-6

    def test_a_negative_manual_offset_may_push_the_start_before_zero(self, tmp_path):
        p = ramp_wav(tmp_path / "t.wav", 5, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([self.take(p, startPosition=1.0, manualOffset=-2.0)], 0.0, 3.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 0.5, 0.0) == pytest.approx((0.5 + 1.0) / 10, abs=2e-3)

    def test_a_take_is_mixed_over_the_stems_at_the_right_place(self, tmp_path):
        stem = const_wav(tmp_path / "s.wav", 0.2, 10, self.SR)
        t = const_wav(tmp_path / "t.wav", 0.3, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": stem, "gain": 1.0, "isTake": False}, self.take(t, startPosition=5.0)], 4.0, 8.0, str(out))
        data, sr = read(out)
        assert at(data, sr, 4.5, 4.0) == pytest.approx(0.2, abs=1e-3)
        assert at(data, sr, 5.5, 4.0) == pytest.approx(0.5, abs=1e-3)
        assert at(data, sr, 7.5, 4.0) == pytest.approx(0.2, abs=1e-3)

    def test_a_take_entirely_after_the_window_contributes_nothing(self, tmp_path):
        stem = const_wav(tmp_path / "s.wav", 0.2, 10, self.SR)
        t = const_wav(tmp_path / "t.wav", 0.3, 2, self.SR)
        out = tmp_path / "o.wav"
        recording.mix_export([{"path": stem, "gain": 1.0, "isTake": False}, self.take(t, startPosition=9.0)], 0.0, 4.0, str(out))
        assert np.allclose(read(out)[0], 0.2, atol=1e-3)


class TestProbeSource:
    def test_wav_durations_are_read_without_decoding(self, tmp_path):
        p = const_wav(tmp_path / "a.wav", 0.1, 2.5, 8000)
        duration, sr, samples = recording._probe_source(p)
        assert (duration, sr, samples) == (2.5, 8000, None)

    @pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs ffmpeg to author a webm/opus take")
    def test_webm_is_decoded_up_front_because_its_duration_metadata_is_unreliable(self, tmp_path):
        wav = write_wav(tmp_path / "src.wav", sine(440, 48000, 1.0), 48000)
        webm = tmp_path / "take.webm"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", wav, "-c:a", "libopus", str(webm)], check=True)
        duration, sr, samples = recording._probe_source(str(webm))
        assert samples is not None and samples.ndim == 2
        assert duration == pytest.approx(1.0, abs=0.1) and sr == 48000


def noise_wav(path, seconds, sr, amp, seed=0):
    rng = np.random.default_rng(seed)
    x = (amp * (rng.random(int(seconds * sr)) * 2 - 1)).astype(np.float32)
    sf.write(str(path), x, sr, subtype="FLOAT")
    return str(path)


class TestNormalizeTake:
    SR = 22050

    def run(self, tmp_path, take_amp, ref_amp=None, **kw):
        take = noise_wav(tmp_path / "take.wav", 2.0, self.SR, take_amp, seed=1)
        ref = noise_wav(tmp_path / "ref.wav", 2.0, self.SR, ref_amp, seed=2) if ref_amp is not None else None
        out = tmp_path / "out.wav"
        result = recording.normalize_take(take, str(out), reference_path=ref, **kw)
        data, sr = sf.read(str(out), dtype="float32")
        return result, data, sr

    def test_matches_the_rms_of_the_reference_stem(self, tmp_path):
        _, data, _ = self.run(tmp_path, take_amp=0.05, ref_amp=0.1)
        assert rms_db(data) == pytest.approx(rms_db(sf.read(str(tmp_path / "ref.wav"))[0]), abs=0.2)

    def test_quiet_take_is_boosted_and_loud_take_attenuated(self, tmp_path):
        quiet, _, _ = self.run(tmp_path, take_amp=0.01, ref_amp=0.1)
        assert quiet["appliedGainDb"] > 10
        loud, _, _ = self.run(tmp_path, take_amp=0.5, ref_amp=0.05)
        assert loud["appliedGainDb"] < -10

    def test_reported_gain_is_the_gain_actually_applied(self, tmp_path):
        result, data, sr = self.run(tmp_path, take_amp=0.05, ref_amp=0.1)
        original, _ = sf.read(str(tmp_path / "take.wav"), dtype="float32")
        assert rms_db(data) - rms_db(original) == pytest.approx(result["appliedGainDb"], abs=0.05)

    def test_never_pushes_peaks_past_the_ceiling(self, tmp_path):
        """A take with rare loud peaks and a quiet body is gain-limited by its peak, not by the target."""
        rng = np.random.default_rng(3)
        x = (0.01 * (rng.random(2 * self.SR) * 2 - 1)).astype(np.float32)
        x[1000] = 0.5
        sf.write(str(tmp_path / "take.wav"), x, self.SR, subtype="FLOAT")
        ref = noise_wav(tmp_path / "ref.wav", 2.0, self.SR, 0.5, seed=2)
        result = recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "out.wav"), reference_path=ref)
        out, _ = sf.read(str(tmp_path / "out.wav"), dtype="float32")
        assert np.max(np.abs(out)) == pytest.approx(10 ** (recording.PEAK_CEILING_DBFS / 20), abs=1e-3)
        assert result["appliedGainDb"] == pytest.approx(20 * np.log10(10 ** (recording.PEAK_CEILING_DBFS / 20) / 0.5), abs=0.05)

    def test_without_a_reference_it_targets_the_fallback_loudness(self, tmp_path):
        _, data, _ = self.run(tmp_path, take_amp=0.05)
        assert rms_db(data) == pytest.approx(recording.TARGET_RMS_DBFS_FALLBACK, abs=0.3)

    def test_a_missing_reference_file_falls_back_rather_than_failing(self, tmp_path):
        take = noise_wav(tmp_path / "take.wav", 1.0, self.SR, 0.05)
        recording.normalize_take(take, str(tmp_path / "o.wav"), reference_path=str(tmp_path / "gone.wav"))
        data, _ = sf.read(str(tmp_path / "o.wav"), dtype="float32")
        assert rms_db(data) == pytest.approx(recording.TARGET_RMS_DBFS_FALLBACK, abs=0.5)

    def test_audio_offset_is_not_trimmed_from_the_file_because_the_player_skips_it_itself(self, tmp_path):
        sr = self.SR
        x = np.concatenate([np.zeros(sr, dtype=np.float32), sine(300, sr, 1.0, amp=0.5)])
        sf.write(str(tmp_path / "take.wav"), x, sr, subtype="FLOAT")
        recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "o.wav"), audio_offset_s=1.0)
        data, _ = sf.read(str(tmp_path / "o.wav"), dtype="float32")
        assert len(data) == len(x)
        assert not data[: sr - 100].any(), "the skipped part keeps its place at the start of the file"

    def test_audio_offset_decides_which_part_of_the_file_sets_the_gain(self, tmp_path):
        sr = self.SR
        x = np.concatenate([np.zeros(sr, dtype=np.float32), sine(300, sr, 1.0, amp=0.1)])
        sf.write(str(tmp_path / "take.wav"), x, sr, subtype="FLOAT")
        full = recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "a.wav"))
        audible = recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "b.wav"), audio_offset_s=1.0)
        assert audible["appliedGainDb"] == pytest.approx(full["appliedGainDb"] - 3.01, abs=0.2)
        data, _ = sf.read(str(tmp_path / "b.wav"), dtype="float32")
        assert rms_db(data[sr:]) == pytest.approx(recording.TARGET_RMS_DBFS_FALLBACK, abs=0.5)

    def test_an_offset_beyond_the_end_of_the_file_does_not_crash(self, tmp_path):
        sf.write(str(tmp_path / "take.wav"), sine(300, self.SR, 0.5), self.SR)
        recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "o.wav"), audio_offset_s=10.0)
        data, _ = sf.read(str(tmp_path / "o.wav"))
        assert len(data) == int(self.SR * 0.5) and not np.isnan(data).any()

    def test_keeps_the_native_sample_rate_and_is_mono(self, tmp_path):
        stereo = np.stack([sine(300, 32000, 1.0), sine(500, 32000, 1.0)], axis=1)
        sf.write(str(tmp_path / "take.wav"), stereo, 32000)
        recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "o.wav"))
        data, sr = sf.read(str(tmp_path / "o.wav"))
        assert sr == 32000 and data.ndim == 1

    def test_silence_stays_silent_and_does_not_divide_by_zero(self, tmp_path):
        sf.write(str(tmp_path / "take.wav"), np.zeros(self.SR, dtype=np.float32), self.SR, subtype="FLOAT")
        result = recording.normalize_take(str(tmp_path / "take.wav"), str(tmp_path / "o.wav"))
        data, _ = sf.read(str(tmp_path / "o.wav"))
        assert not np.isnan(data).any()
        assert not data.any()
        assert np.isfinite(result["appliedGainDb"])

    def test_missing_recording_raises(self, tmp_path):
        with pytest.raises(Exception):
            recording.normalize_take(str(tmp_path / "gone.wav"), str(tmp_path / "o.wav"))

    def test_the_output_path_is_returned(self, tmp_path):
        result, _, _ = self.run(tmp_path, take_amp=0.05)
        assert result["path"] == str(tmp_path / "out.wav")
