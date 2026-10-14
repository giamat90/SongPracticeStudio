"""processor.py: the stem pipeline (Demucs replaced by a fake), key / chord / bass-tab analysis and the key transpose."""

import json
import os

import numpy as np
import pytest
import soundfile as sf

import processor
from helpers import sine, write_wav

SR = processor.SAMPLE_RATE


# ─── a stand-in for Demucs ─────────────────────────────────────────────────

class FakeTensor:
    """Just enough of torch.Tensor for processor._save_stem and the stem merging."""

    def __init__(self, array):
        self.array = np.asarray(array, dtype=np.float32)

    def __mul__(self, other):
        return FakeTensor(self.array * other)

    def __add__(self, other):
        return FakeTensor(self.array + (other.array if isinstance(other, FakeTensor) else other))

    def numpy(self):
        return self.array

    def std(self):
        return float(self.array.std())

    def mean(self):
        return float(self.array.mean())


# small enough that denormalised sums stay below full scale (the 16-bit WAV writer clips there)
STEM_VALUE = {"vocals": 0.02, "drums": 0.04, "bass": 0.06, "guitar": 0.08, "piano": 0.10, "other": 0.12}
FOUR_STEM = ["vocals", "drums", "bass", "other"]
SIX_STEM = ["vocals", "drums", "bass", "guitar", "piano", "other"]
REF_STD, REF_MEAN = 2.0, 0.25


class FakeDemucs:
    """Records every model run and returns constant-valued stems (so a merge is a plain sum)."""

    def __init__(self, seconds=2, overrides=None):
        self.runs = []
        self.seconds = seconds
        self.overrides = overrides or {}

    def __call__(self, model_name, input_path, p0, p1, on_progress):
        self.runs.append((model_name, os.path.basename(input_path), p0, p1))
        on_progress(p0, "stem-separation")
        on_progress(p1, "stem-separation")
        names = SIX_STEM if model_name == "htdemucs_6s" else FOUR_STEM
        n = int(self.seconds * 44100)
        stems = {
            name: FakeTensor(self.overrides.get(name, np.full((2, n), STEM_VALUE[name], dtype=np.float32)))
            for name in names
        }
        # ref.std() / ref.mean() undo the normalisation: written = stem * std + mean
        ref = FakeTensor(np.array([REF_MEAN - REF_STD, REF_MEAN + REF_STD] * (n // 2), dtype=np.float32))
        assert ref.std() == pytest.approx(REF_STD, rel=1e-3) and ref.mean() == pytest.approx(REF_MEAN, abs=1e-3)
        return stems, ref, 44100


def written(out_dir, name):
    data, sr = sf.read(os.path.join(out_dir, f"{name}.wav"), dtype="float32", always_2d=True)
    return data, sr


def expected(value):
    return value * REF_STD + REF_MEAN


@pytest.fixture
def mix(tmp_path):
    """A short song with a clear tempo, key and chord, standing in for the user's source file."""
    sr = SR
    t = np.arange(int(sr * 8)) / sr
    chord = sum(np.sin(2 * np.pi * f * t) for f in (261.63, 329.63, 392.00)) * 0.15
    clicks = np.zeros_like(t)
    for beat in np.arange(0, 8, 0.5):  # 120 BPM
        i = int(beat * sr)
        clicks[i:i + 200] += np.hanning(200) * 0.8
    return write_wav(tmp_path / "mix.wav", (chord + clicks).astype(np.float32), sr)


@pytest.fixture
def demucs(monkeypatch):
    fake = FakeDemucs()
    monkeypatch.setattr(processor, "_run_demucs", fake)
    return fake


def run(mix, out, **kw):
    events = []
    result = processor.process(mix, str(out), on_progress=lambda v, s: events.append((v, s)), **kw)
    return result, events


# ─── model selection and stem handling ─────────────────────────────────────

class TestProcessModelSelection:
    def test_no_guitar_or_piano_is_a_single_standard_pass(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals", "drums"])
        assert [r[0] for r in demucs.runs] == ["htdemucs"]
        assert demucs.runs[0][2:] == (0.0, 0.75)

    def test_high_quality_uses_the_fine_tuned_model(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals"], high_quality=True)
        assert [r[0] for r in demucs.runs] == ["htdemucs_ft"]

    @pytest.mark.parametrize("stem", ["guitar", "piano"])
    def test_guitar_or_piano_triggers_the_cascade(self, mix, demucs, tmp_path, stem):
        run(mix, tmp_path / "o", stems_to_extract=["vocals", stem])
        assert [r[0] for r in demucs.runs] == ["htdemucs", "htdemucs_6s"]
        assert demucs.runs[0][2:] == (0.0, 0.40)
        assert demucs.runs[1][2:] == (0.40, 0.75)

    def test_the_second_pass_separates_the_first_passes_residual_not_the_original(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["guitar"])
        assert demucs.runs[0][1] == os.path.basename(mix)
        assert demucs.runs[1][1] == "_other_pass1.wav"

    def test_high_quality_only_changes_the_first_pass_of_a_cascade(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["guitar"], high_quality=True)
        assert [r[0] for r in demucs.runs] == ["htdemucs_ft", "htdemucs_6s"]

    def test_the_default_is_all_six_stems_through_the_cascade(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o")
        assert sorted(result["stems"]) == sorted(SIX_STEM)
        assert [r[0] for r in demucs.runs] == ["htdemucs", "htdemucs_6s"]

    def test_the_temporary_residual_file_is_removed(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["guitar"])
        assert not (tmp_path / "o" / "_other_pass1.wav").exists()

    def test_creates_the_output_directory(self, mix, demucs, tmp_path):
        out = tmp_path / "deep" / "er"
        run(mix, out, stems_to_extract=["vocals"])
        assert (out / "vocals.wav").exists()

    @pytest.mark.parametrize("stems", [[], ["kazoo"]])
    def test_a_request_with_no_valid_stem_is_a_clear_error(self, mix, demucs, tmp_path, stems):
        with pytest.raises(ValueError, match="No valid stems"):
            run(mix, tmp_path / "o", stems_to_extract=stems)
        assert demucs.runs == []


class TestProcessStemContents:
    def test_only_the_requested_stems_are_written(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["vocals", "bass"])
        assert sorted(result["stems"]) == ["bass", "vocals"]
        assert sorted(p.name for p in (tmp_path / "o").glob("*.wav")) == ["bass.wav", "vocals.wav"]

    def test_stems_are_denormalised_with_the_reference_statistics(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        data, sr = written(tmp_path / "o", "vocals")
        assert sr == 44100 and data.shape[1] == 2
        assert np.allclose(data, expected(STEM_VALUE["vocals"]), atol=2e-3)

    def test_returned_paths_point_at_the_written_files(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["drums"])
        assert result["stems"]["drums"] == str(tmp_path / "o" / "drums.wav")

    def test_single_pass_folds_unrequested_stems_into_other(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals", "other"])
        data, _ = written(tmp_path / "o", "other")
        merged = STEM_VALUE["other"] + STEM_VALUE["drums"] + STEM_VALUE["bass"]
        assert np.allclose(data, merged * REF_STD + REF_MEAN, atol=2e-3)

    def test_single_pass_other_is_untouched_when_everything_is_requested_or_other_is_absent(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "a", stems_to_extract=["vocals", "drums", "bass", "other"])
        data, _ = written(tmp_path / "a", "other")
        assert np.allclose(data, expected(STEM_VALUE["other"]), atol=2e-3)

    def test_cascade_takes_vocals_drums_and_bass_from_the_first_pass(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals", "drums", "bass", "guitar"])
        for name in ("vocals", "drums", "bass"):
            data, _ = written(tmp_path / "o", name)
            assert np.allclose(data, expected(STEM_VALUE[name]), atol=2e-3), name

    def test_cascade_takes_guitar_and_piano_from_the_second_pass(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["guitar", "piano"])
        for name in ("guitar", "piano"):
            data, _ = written(tmp_path / "o", name)
            assert np.allclose(data, expected(STEM_VALUE[name]), atol=2e-3), name

    def test_cascade_folds_an_unrequested_guitar_or_piano_into_other(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["guitar", "other"])
        data, _ = written(tmp_path / "o", "other")
        assert np.allclose(data, (STEM_VALUE["other"] + STEM_VALUE["piano"]) * REF_STD + REF_MEAN, atol=2e-3)

    def test_cascade_other_does_not_get_unrequested_vocals_drums_or_bass_back(self, mix, demucs, tmp_path):
        """Documents current behaviour: unlike a single pass, the cascade's "other" is the residual of pass 1 only."""
        run(mix, tmp_path / "o", stems_to_extract=["guitar", "piano", "other"])
        data, _ = written(tmp_path / "o", "other")
        assert np.allclose(data, expected(STEM_VALUE["other"]), atol=2e-3)

    def test_cascade_discards_the_bleed_of_vocals_drums_and_bass_from_the_second_pass(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["vocals", "guitar"])
        assert sorted(result["stems"]) == ["guitar", "vocals"]
        data, _ = written(tmp_path / "o", "vocals")
        assert np.allclose(data, expected(STEM_VALUE["vocals"]), atol=2e-3)


# ─── analysis results, progress, degradation ───────────────────────────────

class TestProcessResult:
    def test_reports_duration_bpm_key_and_what_was_written(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        assert result["duration"] == pytest.approx(2.0, abs=0.01)
        assert result["detectedBpm"] == pytest.approx(120, abs=6) or result["detectedBpm"] == pytest.approx(60, abs=3)
        assert result["detectedKey"] == "C major"
        assert result["chords"] is True
        assert result["bassTab"] is False
        assert set(result) == {"stems", "duration", "detectedBpm", "detectedKey", "chords", "bassTab"}

    def test_the_result_is_json_serialisable_for_the_wire(self, mix, demucs, tmp_path):
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        assert json.loads(json.dumps(result)) == result

    def test_chords_json_has_the_documented_shape(self, mix, demucs, tmp_path):
        run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        doc = json.loads((tmp_path / "o" / "chords.json").read_text(encoding="utf-8"))
        assert doc["version"] == 5 and doc["duration"] == pytest.approx(2.0, abs=0.01)
        assert doc["segments"] and doc["segments"][0]["chord"] == "C:maj"
        assert set(doc["segments"][0]) == {"start", "end", "chord", "confidence"}

    def test_a_bass_tab_is_written_only_when_a_bass_stem_was_extracted(self, mix, tmp_path, monkeypatch):
        tone = np.tile(sine(55, 44100, 1.0, amp=0.5), (2, 1))
        monkeypatch.setattr(processor, "_run_demucs", FakeDemucs(overrides={"bass": tone}))
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["bass"])
        assert result["bassTab"] is True
        tab = json.loads((tmp_path / "o" / "bass_tab.json").read_text(encoding="utf-8"))
        assert tab["version"] == 1 and tab["notes"]
        assert {"time", "duration", "pitch", "string", "fret"} <= set(tab["notes"][0])

        result, _ = run(mix, tmp_path / "p", stems_to_extract=["vocals"])
        assert result["bassTab"] is False
        assert not (tmp_path / "p" / "bass_tab.json").exists()


class TestProcessProgress:
    def test_never_goes_backwards_and_finishes_complete(self, mix, demucs, tmp_path):
        _, events = run(mix, tmp_path / "o", stems_to_extract=["guitar", "bass"])
        values = [v for v, _ in events]
        assert values == sorted(values)
        assert events[-1] == (1.0, "complete")
        assert all(0.0 <= v <= 1.0 for v in values)

    def test_stages_come_in_pipeline_order(self, mix, demucs, tmp_path):
        _, events = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        order = []
        for _, stage in events:
            if not order or order[-1] != stage:
                order.append(stage)
        assert order == ["stem-separation", "bpm-detection", "key-detection", "chord-detection", "bass-tab", "complete"]

    def test_separation_hands_over_to_bpm_without_a_gap_or_overlap(self, mix, demucs, tmp_path):
        _, events = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        assert (0.75, "bpm-detection") in events and (0.86, "key-detection") in events

    def test_works_without_a_progress_callback(self, mix, demucs, tmp_path):
        assert processor.process(mix, str(tmp_path / "o"), stems_to_extract=["vocals"])["stems"]


class TestProcessDegradesGracefully:
    def test_a_bpm_failure_leaves_the_tempo_empty_but_finishes(self, mix, demucs, tmp_path, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("no beats")

        monkeypatch.setattr(processor.librosa.beat, "tempo", boom)
        result, events = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        assert result["detectedBpm"] is None
        assert events[-1] == (1.0, "complete")

    def test_a_chord_failure_is_non_fatal(self, mix, demucs, tmp_path, monkeypatch):
        monkeypatch.setattr(processor, "_detect_chords", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("cqt")))
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["vocals"])
        assert result["chords"] is False
        assert not (tmp_path / "o" / "chords.json").exists()

    def test_a_bass_tab_failure_is_non_fatal(self, mix, demucs, tmp_path, monkeypatch):
        monkeypatch.setattr(processor, "_transcribe_bass", lambda p: (_ for _ in ()).throw(RuntimeError("pyin")))
        result, _ = run(mix, tmp_path / "o", stems_to_extract=["bass"])
        assert result["bassTab"] is False
        assert "bass" in result["stems"]

    def test_a_demucs_failure_propagates_so_the_caller_can_report_it(self, mix, tmp_path, monkeypatch):
        def boom(*a, **k):
            raise RuntimeError("model download failed")

        monkeypatch.setattr(processor, "_run_demucs", boom)
        with pytest.raises(RuntimeError, match="model download failed"):
            run(mix, tmp_path / "o", stems_to_extract=["vocals"])


# ─── bundled models ────────────────────────────────────────────────────────

class TestBundledModelRepo:
    def test_dev_mode_uses_vendor_models_only_when_they_exist(self, monkeypatch, tmp_path):
        monkeypatch.setattr(processor, "__file__", str(tmp_path / "processor.py"))
        assert processor._bundled_model_repo() is None
        (tmp_path / "vendor" / "demucs-models").mkdir(parents=True)
        assert processor._bundled_model_repo() == tmp_path / "vendor" / "demucs-models"

    def test_frozen_build_looks_next_to_the_unpacked_bundle(self, monkeypatch, tmp_path):
        monkeypatch.setattr(processor.sys, "frozen", True, raising=False)
        monkeypatch.setattr(processor.sys, "_MEIPASS", str(tmp_path), raising=False)
        assert processor._bundled_model_repo() is None
        (tmp_path / "demucs-models").mkdir()
        assert processor._bundled_model_repo() == tmp_path / "demucs-models"


# ─── key detection ─────────────────────────────────────────────────────────

def chord_audio(freqs, seconds, sr=SR, amp=0.15):
    t = np.arange(int(sr * seconds)) / sr
    return (sum(np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t) for f in freqs) * amp).astype(np.float32)


C_MAJOR = (261.63, 329.63, 392.00)
A_MINOR = (220.00, 261.63, 329.63)
G_MAJOR = (196.00, 246.94, 293.66)
E_MINOR = (164.81, 196.00, 246.94)


class TestKeyDetection:
    def test_a_c_major_triad_is_c_major(self, tmp_path):
        p = write_wav(tmp_path / "k.wav", chord_audio(C_MAJOR, 6), SR)
        assert processor._detect_key_chroma(p) == "C major"

    def test_an_a_minor_progression_is_a_minor(self, tmp_path):
        audio = np.concatenate([chord_audio(A_MINOR, 3), chord_audio(E_MINOR, 1.5), chord_audio(A_MINOR, 3)])
        p = write_wav(tmp_path / "k.wav", audio, SR)
        assert processor._detect_key_chroma(p) == "A minor"

    def test_transposing_the_music_transposes_the_key(self, tmp_path):
        up = [f * 2 ** (2 / 12) for f in C_MAJOR]
        p = write_wav(tmp_path / "k.wav", chord_audio(up, 6), SR)
        assert processor._detect_key_chroma(p) == "D major"

    def test_an_unreadable_file_gives_unknown_instead_of_raising(self, tmp_path):
        bad = tmp_path / "bad.wav"
        bad.write_bytes(b"not audio")
        assert processor._detect_key_chroma(str(bad)) == "Unknown"

    def test_only_the_first_minute_is_analysed(self, tmp_path, monkeypatch):
        seen = {}
        real = processor.librosa.load

        def spy(path, **kw):
            seen.update(kw)
            return real(path, **kw)

        monkeypatch.setattr(processor.librosa, "load", spy)
        processor._detect_key_chroma(write_wav(tmp_path / "k.wav", chord_audio(C_MAJOR, 2), SR))
        assert seen["duration"] == 60 and seen["sr"] == SR


# ─── chord detection ───────────────────────────────────────────────────────

class TestChordDetection:
    def test_templates_cover_all_24_major_and_minor_triads(self):
        names = list(processor.CHORD_TEMPLATES)
        assert len(names) == 24
        assert {n.split(":")[1] for n in names} == {"maj", "min"}
        assert processor.CHORD_TEMPLATES["C:maj"].tolist() == [1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0]
        assert processor.CHORD_TEMPLATES["A:min"].nonzero()[0].tolist() == [0, 4, 9]
        assert all(t.sum() == 3 for t in processor.CHORD_TEMPLATES.values())

    def test_follows_a_progression_with_boundaries_near_the_changes(self, tmp_path):
        audio = np.concatenate([chord_audio(C_MAJOR, 4), chord_audio(G_MAJOR, 4), chord_audio(A_MINOR, 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", audio, SR))
        assert [s["chord"] for s in segs] == ["C:maj", "G:maj", "A:min"]
        assert segs[1]["start"] == pytest.approx(4.0, abs=1.1)
        assert segs[2]["start"] == pytest.approx(8.0, abs=1.1)
        assert segs[-1]["end"] == pytest.approx(12.0, abs=0.1)

    def test_every_chord_carries_a_confidence_that_a_clean_chord_earns(self, tmp_path):
        audio = np.concatenate([chord_audio(C_MAJOR, 4), chord_audio(G_MAJOR, 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", audio, SR))
        assert all(0.0 <= s["confidence"] <= 1.0 for s in segs)
        assert all(s["confidence"] > 0.9 for s in segs)

    def test_a_muddy_chord_is_less_certain_than_a_clean_one(self, tmp_path):
        rng = np.random.default_rng(3)
        noise = (rng.normal(0, 0.25, SR * 4)).astype(np.float32)
        clean = processor._detect_chords_chroma(write_wav(tmp_path / "a.wav", chord_audio(C_MAJOR, 4), SR))
        muddy = processor._detect_chords_chroma(
            write_wav(tmp_path / "b.wav", chord_audio(C_MAJOR, 4) + noise, SR))
        assert muddy and muddy[0]["confidence"] < clean[0]["confidence"]

    def test_segments_are_contiguous_and_ordered(self, tmp_path):
        audio = np.concatenate([chord_audio(C_MAJOR, 3), chord_audio(G_MAJOR, 3)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", audio, SR))
        for a, b in zip(segs, segs[1:]):
            assert a["end"] == b["start"]
        assert all(s["end"] > s["start"] for s in segs)

    def test_silence_produces_no_chords(self, tmp_path):
        p = write_wav(tmp_path / "s.wav", np.zeros(SR * 3, dtype=np.float32), SR)
        assert processor._detect_chords_chroma(p) == []

    def test_leading_silence_is_not_labelled(self, tmp_path):
        audio = np.concatenate([np.zeros(SR * 3, dtype=np.float32), chord_audio(C_MAJOR, 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "s.wav", audio, SR))
        assert segs[0]["chord"] == "C:maj" and segs[0]["start"] == pytest.approx(3.0, abs=1.1)

    def test_a_window_the_audio_does_not_back_is_smoothed_away(self, tmp_path):
        both = chord_audio(C_MAJOR, 1.0) + chord_audio(G_MAJOR, 1.0)
        audio = np.concatenate([chord_audio(C_MAJOR, 4), both, chord_audio(C_MAJOR, 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "s.wav", audio, SR))
        assert [s["chord"] for s in segs] == ["C:maj"]

    def test_a_short_change_that_is_clearly_there_is_kept(self, tmp_path):
        audio = np.concatenate([chord_audio(C_MAJOR, 4), chord_audio(G_MAJOR, 1.0), chord_audio(C_MAJOR, 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "s.wav", audio, SR))
        assert [s["chord"] for s in segs] == ["C:maj", "G:maj", "C:maj"]
        assert segs[1]["start"] == pytest.approx(4.0, abs=0.1)

    @pytest.mark.parametrize("cents", [-35, 29, 45])
    def test_a_recording_off_concert_pitch_reads_the_same_chords(self, tmp_path, cents):
        ratio = 2 ** (cents / 1200)
        detune = lambda chord: tuple(f * ratio for f in chord)
        audio = np.concatenate([chord_audio(detune(C_MAJOR), 4), chord_audio(detune(G_MAJOR), 4), chord_audio(detune(A_MINOR), 4)])
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", audio, SR))
        assert [s["chord"] for s in segs] == ["C:maj", "G:maj", "A:min"]

    def test_a_clip_shorter_than_the_smoothing_window_still_works(self, tmp_path):
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "s.wav", chord_audio(C_MAJOR, 1.5), SR))
        assert segs and segs[0]["chord"] == "C:maj"


def weighted_chord(tones, seconds, sr=SR):
    """tones: (frequency, amplitude) pairs, each with one overtone like chord_audio."""
    t = np.arange(int(sr * seconds)) / sr
    return sum(a * (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t)) for f, a in tones).astype(np.float32)


C4, E4, G4, BB4, B4, A3 = 261.63, 329.63, 392.00, 466.16, 493.88, 220.00


class TestSeventhChords:
    def test_seventh_templates_have_four_notes_and_their_own_qualities(self):
        assert {n.split(":")[1] for n in processor.SEVENTH_TEMPLATES} == {"7", "maj7", "min7"}
        assert len(processor.SEVENTH_TEMPLATES) == 36
        assert processor.SEVENTH_TEMPLATES["C:7"].nonzero()[0].tolist() == [0, 4, 7, 10]
        assert processor.SEVENTH_TEMPLATES["C:maj7"].nonzero()[0].tolist() == [0, 4, 7, 11]
        assert processor.SEVENTH_TEMPLATES["A:min7"].nonzero()[0].tolist() == [0, 4, 7, 9]
        assert all(t.sum() == 4 for t in processor.SEVENTH_TEMPLATES.values())

    @pytest.mark.parametrize("tones,expected", [
        ([(C4, 0.15), (E4, 0.15), (G4, 0.15), (BB4, 0.15)], "C:7"),
        ([(C4, 0.15), (E4, 0.15), (G4, 0.15), (B4, 0.15)], "C:maj7"),
        ([(A3, 0.15), (C4, 0.15), (E4, 0.15), (G4, 0.15)], "A:min7"),
    ])
    def test_a_clear_seventh_is_named(self, tmp_path, tones, expected):
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", weighted_chord(tones, 5), SR))
        assert [s["chord"] for s in segs] == [expected]

    def test_a_faint_seventh_stays_a_triad(self, tmp_path):
        tones = [(C4, 0.15), (E4, 0.15), (G4, 0.15), (BB4, 0.03)]
        segs = processor._detect_chords_chroma(write_wav(tmp_path / "c.wav", weighted_chord(tones, 5), SR))
        assert [s["chord"] for s in segs] == ["C:maj"]


class TestSlashChords:
    E2, C2, D2 = 82.41, 65.41, 73.42

    def song(self, tmp_path, bass_hz):
        mix = write_wav(tmp_path / "mix.wav", chord_audio(C_MAJOR, 5), SR)
        bass = write_wav(tmp_path / "bass.wav", sine(bass_hz, SR, 5, amp=0.4), SR)
        return mix, bass

    def test_a_chord_tone_in_the_bass_makes_a_slash_chord(self, tmp_path):
        mix, bass = self.song(tmp_path, self.E2)
        segs = processor._detect_chords_chroma(mix, bass_path=bass)
        assert [(s["chord"], s.get("bass")) for s in segs] == [("C:maj", "E")]

    def test_the_root_in_the_bass_adds_nothing(self, tmp_path):
        mix, bass = self.song(tmp_path, self.C2)
        segs = processor._detect_chords_chroma(mix, bass_path=bass)
        assert "bass" not in segs[0]

    def test_a_bass_note_outside_the_chord_is_ignored(self, tmp_path):
        mix, bass = self.song(tmp_path, self.D2)
        segs = processor._detect_chords_chroma(mix, bass_path=bass)
        assert "bass" not in segs[0]

    def test_without_a_bass_stem_there_is_no_bass_field(self, tmp_path):
        mix, _ = self.song(tmp_path, self.E2)
        assert "bass" not in processor._detect_chords_chroma(mix)[0]

    def test_the_same_chord_over_a_new_bass_note_is_a_new_segment(self, tmp_path):
        mix = write_wav(tmp_path / "mix.wav", chord_audio(C_MAJOR, 8), SR)
        bass_audio = np.concatenate([sine(self.C2, SR, 4, amp=0.4), sine(self.E2, SR, 4, amp=0.4)])
        bass = write_wav(tmp_path / "bass.wav", bass_audio, SR)
        segs = processor._detect_chords_chroma(mix, bass_path=bass)
        assert [(s["chord"], s.get("bass")) for s in segs] == [("C:maj", None), ("C:maj", "E")]


class TestRedetectChords:
    def test_sums_the_stems_and_writes_chords_json(self, tmp_path):
        a = write_wav(tmp_path / "other.wav", chord_audio(C_MAJOR, 5), SR)
        b = write_wav(tmp_path / "bass.wav", sine(82.41, SR, 5, amp=0.4), SR)
        out = tmp_path / "chords.json"
        result = processor.detect_chords_from_stems({"other": a, "bass": b}, str(out))
        assert result == {"segments": 1}
        doc = json.loads(out.read_text(encoding="utf-8"))
        assert doc["version"] == 5
        assert doc["segments"][0]["chord"] == "C:maj" and doc["segments"][0]["bass"] == "E"
        assert doc["duration"] == pytest.approx(5.0, abs=0.1)

    def test_no_stems_is_an_error(self, tmp_path):
        with pytest.raises(ValueError):
            processor.detect_chords_from_stems({}, str(tmp_path / "c.json"))

    def test_leaves_the_drums_and_vocals_out(self, tmp_path):
        stems = {
            "other": write_wav(tmp_path / "other.wav", chord_audio(C_MAJOR, 5, amp=0.05), SR),
            "vocals": write_wav(tmp_path / "vocals.wav", chord_audio(G_MAJOR, 5, amp=0.2), SR),
            "drums": write_wav(tmp_path / "drums.wav", chord_audio(E_MINOR, 5, amp=0.2), SR),
        }
        out = tmp_path / "chords.json"
        processor.detect_chords_from_stems(stems, str(out))
        segs = json.loads(out.read_text(encoding="utf-8"))["segments"]
        assert [s["chord"] for s in segs] == ["C:maj"]

    def test_a_song_with_only_drums_and_vocals_is_read_from_all_of_them(self, tmp_path):
        stems = {"vocals": write_wav(tmp_path / "vocals.wav", chord_audio(G_MAJOR, 5), SR)}
        out = tmp_path / "chords.json"
        assert processor.detect_chords_from_stems(stems, str(out)) == {"segments": 1}
        assert json.loads(out.read_text(encoding="utf-8"))["segments"][0]["chord"] == "G:maj"


# ─── beat windows and Viterbi decoding ─────────────────────────────────────

FRAME_DUR = processor._CHORD_HOP_LENGTH / SR


def click_track(beat_seconds, total_seconds, sr=SR):
    """A decaying noise burst at every beat (a drum hit): something a beat tracker can lock to."""
    out = np.zeros(int(total_seconds * sr), dtype=np.float32)
    burst_len = int(0.03 * sr)
    t = np.arange(burst_len) / sr
    burst = (0.8 * np.random.default_rng(0).standard_normal(burst_len) * np.exp(-t / 0.008)).astype(np.float32)
    for beat in beat_seconds:
        i = int(beat * sr)
        out[i:i + burst_len] += burst[: len(out) - i]
    return out


class TestWindows:
    def test_the_grid_cuts_whole_windows_and_folds_a_short_remainder_into_the_last(self):
        # 10 frames per window, 25 frames: 0-10, 10-25 (remainder of 5 is exactly half, so it stays)
        assert processor._grid_windows(25, 10) == [(0, 10), (10, 20), (20, 25)]
        assert processor._grid_windows(24, 10) == [(0, 10), (10, 24)]
        assert processor._grid_windows(4, 10) == [(0, 4)]

    def test_beat_windows_cover_the_whole_signal_without_gaps(self):
        n = round(10 / FRAME_DUR)
        beats = [round(t / FRAME_DUR) for t in (0.4, 0.9, 1.4, 1.9, 2.4)]
        windows = processor._beat_windows(beats, n, FRAME_DUR)
        assert windows[0][0] == 0 and windows[-1][1] == n
        assert all(a[1] == b[0] for a, b in zip(windows, windows[1:]))

    def test_a_beat_next_to_the_start_does_not_make_a_sliver(self):
        n = round(4 / FRAME_DUR)
        first_real = round(0.7 / FRAME_DUR)
        windows = processor._beat_windows([2, first_real], n, FRAME_DUR)
        assert windows[0] == (0, first_real)

    def test_a_slow_beat_is_cut_so_no_window_is_longer_than_the_limit(self):
        n = round(6 / FRAME_DUR)
        windows = processor._beat_windows([round(3 / FRAME_DUR)], n, FRAME_DUR)
        longest = max(b - a for a, b in windows) * FRAME_DUR
        assert longest <= processor._MAX_WINDOW_SECONDS + FRAME_DUR
        assert len(windows) > 2


class TestViterbi:
    def costs(self, n=3, cost=0.1):
        c = np.full((n, n), cost)
        np.fill_diagonal(c, 0.0)
        return c

    def test_a_clear_run_is_followed(self):
        em = np.array([[1, 0, 0]] * 3 + [[0, 1, 0]] * 3, dtype=float)
        assert processor._viterbi(em, self.costs()) == [0, 0, 0, 1, 1, 1]

    def test_one_window_that_wins_by_less_than_two_changes_is_ignored(self):
        em = np.array([[1, 0, 0], [1, 0, 0], [0.4, 0.55, 0], [1, 0, 0], [1, 0, 0]], dtype=float)
        assert processor._viterbi(em, self.costs(cost=0.1)) == [0, 0, 0, 0, 0]

    def test_one_window_that_wins_by_more_is_kept(self):
        em = np.array([[1, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0]], dtype=float)
        assert processor._viterbi(em, self.costs(cost=0.1)) == [0, 0, 1, 0, 0]

    def test_a_single_window_is_its_own_best_state(self):
        assert processor._viterbi(np.array([[0.1, 0.9, 0.2]]), self.costs()) == [1]


class TestTransitionCosts:
    names = ["C:maj", "C:7", "G:maj", "D:min", "N"]

    def test_staying_is_free_and_related_chords_are_cheaper_than_strangers(self):
        c = processor._transition_costs(self.names)
        assert all(c[i, i] == 0 for i in range(len(self.names)))
        same_root, fifth, other, silence = c[0, 1], c[0, 2], c[0, 3], c[0, 4]
        assert same_root < fifth < other
        assert silence < same_root + 0.1

    def test_costs_are_symmetric(self):
        c = processor._transition_costs(self.names)
        assert np.allclose(c, c.T)


class TestKeyPrior:
    def test_the_chords_of_c_major(self):
        chords = processor._diatonic_chords(0, "major")
        assert {"C:maj", "F:maj", "G:maj", "D:min", "E:min", "A:min", "G:7", "C:maj7"} <= chords
        assert "C#:maj" not in chords and "B:maj" not in chords and "C:7" not in chords

    def test_the_chords_of_a_minor_include_the_major_dominant(self):
        chords = processor._diatonic_chords(9, "minor")
        assert {"A:min", "D:min", "E:min", "E:maj", "C:maj", "G:maj", "F:maj"} <= chords


class TestBeatFrames:
    def test_a_click_track_gives_its_beats(self, tmp_path):
        beats = np.arange(0, 12, 0.5)
        p = write_wav(tmp_path / "drums.wav", click_track(beats, 12), SR)
        frames = processor._beat_frames({"drums": p})
        assert frames is not None
        interval = float(np.median(np.diff(frames))) * FRAME_DUR
        assert interval == pytest.approx(0.5, abs=0.05)

    def test_too_few_beats_is_not_a_pulse(self, tmp_path):
        p = write_wav(tmp_path / "drums.wav", click_track(np.arange(0, 3, 0.5), 3), SR)
        assert processor._beat_frames({"drums": p}) is None

    def test_an_unreadable_file_has_no_beats_instead_of_raising(self, tmp_path):
        bad = tmp_path / "bad.wav"
        bad.write_bytes(b"not audio")
        assert processor._beat_frames({"drums": str(bad)}) is None

    def test_only_the_drums_and_bass_are_tracked_when_there_are_drums(self, tmp_path, monkeypatch):
        seen = {}

        def fake_sum(paths):
            seen["paths"] = sorted(paths)
            return np.zeros(SR, dtype=np.float32)

        monkeypatch.setattr(processor, "_sum_audio_files", fake_sum)
        processor._beat_frames({"drums": "d", "bass": "b", "other": "o", "vocals": "v"})
        assert seen["paths"] == ["bass", "drums"]
        processor._beat_frames({"other": "o", "vocals": "v"})
        assert seen["paths"] == ["other", "vocals"]


class TestChordsFollowTheBeats:
    def song(self, tmp_path, change_at):
        """120 bpm clicks; C then G, changing at `change_at` seconds (not on a whole second)."""
        total = 12.0
        t = np.arange(int(total * SR)) / SR
        harmony = np.where(
            t < change_at,
            chord_audio(C_MAJOR, total),
            chord_audio(G_MAJOR, total),
        ).astype(np.float32)
        return {
            "other": write_wav(tmp_path / "other.wav", harmony, SR),
            "drums": write_wav(tmp_path / "drums.wav", click_track(np.arange(0, total, 0.5), total), SR),
        }

    def test_a_change_between_whole_seconds_lands_on_its_beat(self, tmp_path):
        segs, _ = processor._detect_chords(self.song(tmp_path, change_at=6.5))
        assert [s["chord"] for s in segs] == ["C:maj", "G:maj"]
        assert segs[1]["start"] == pytest.approx(6.5, abs=0.12)

    def test_the_fixed_grid_would_have_been_a_second_off(self, tmp_path):
        stems = self.song(tmp_path, change_at=6.5)
        segs = processor._detect_chords_chroma(stems["other"])
        assert segs[1]["start"] in (pytest.approx(6.0, abs=0.05), pytest.approx(7.0, abs=0.05))


# ─── which audio the chords are read from ──────────────────────────────────

class TestHarmonicStems:
    def paths(self, *names):
        return {n: f"/song/{n}.wav" for n in names}

    def test_drums_and_vocals_are_left_out(self):
        got = processor._harmonic_stem_paths(self.paths("vocals", "drums", "bass", "guitar", "piano", "other"))
        assert sorted(got) == ["bass", "guitar", "other", "piano"]

    @pytest.mark.parametrize("name", ["guitar", "piano", "other"])
    def test_any_one_harmony_stem_is_enough(self, name):
        assert sorted(processor._harmonic_stem_paths(self.paths("vocals", name))) == [name]

    def test_the_bass_stays_with_the_harmony_stems(self):
        assert sorted(processor._harmonic_stem_paths(self.paths("bass", "other", "drums"))) == ["bass", "other"]

    @pytest.mark.parametrize("names", [[], ["vocals"], ["drums"], ["vocals", "drums"], ["bass"], ["bass", "vocals", "drums"]])
    def test_nothing_that_carries_the_harmony_means_no_harmonic_mix(self, names):
        assert processor._harmonic_stem_paths(self.paths(*names)) is None


class TestChordSource:
    def audio(self, tmp_path, name, freqs, amp=0.15, seconds=5):
        return write_wav(tmp_path / f"{name}.wav", chord_audio(freqs, seconds, amp=amp), SR)

    def test_a_loud_vocal_does_not_change_the_chord(self, tmp_path):
        stems = {
            "other": self.audio(tmp_path, "other", C_MAJOR, amp=0.05),
            "vocals": self.audio(tmp_path, "vocals", G_MAJOR, amp=0.2),
        }
        mix = self.audio(tmp_path, "mix", G_MAJOR)
        segs, duration = processor._detect_chords(stems, mix)
        assert [s["chord"] for s in segs] == ["C:maj"]
        assert duration == pytest.approx(5.0, abs=0.1)

    def test_the_original_mix_is_the_fallback_when_there_is_no_harmony_stem(self, tmp_path):
        stems = {
            "vocals": self.audio(tmp_path, "vocals", C_MAJOR),
            "drums": self.audio(tmp_path, "drums", C_MAJOR),
        }
        mix = self.audio(tmp_path, "mix", G_MAJOR)
        segs, _ = processor._detect_chords(stems, mix)
        assert [s["chord"] for s in segs] == ["G:maj"]

    def test_a_bass_line_alone_does_not_replace_the_mix(self, tmp_path):
        stems = {
            "bass": write_wav(tmp_path / "bass.wav", sine(82.41, SR, 5, amp=0.4), SR),
            "vocals": self.audio(tmp_path, "vocals", C_MAJOR),
        }
        mix = self.audio(tmp_path, "mix", G_MAJOR)
        segs, _ = processor._detect_chords(stems, mix)
        assert [s["chord"] for s in segs] == ["G:maj"]

    def test_the_bass_still_gives_slash_chords_when_the_mix_is_the_fallback(self, tmp_path):
        stems = {"bass": write_wav(tmp_path / "bass.wav", sine(82.41, SR, 5, amp=0.4), SR)}
        mix = self.audio(tmp_path, "mix", C_MAJOR)
        segs, _ = processor._detect_chords(stems, mix)
        assert [(s["chord"], s.get("bass")) for s in segs] == [("C:maj", "E")]

    def test_the_bass_is_part_of_the_harmonic_mix(self, tmp_path):
        stems = {
            "other": self.audio(tmp_path, "other", C_MAJOR),
            "bass": write_wav(tmp_path / "bass.wav", sine(82.41, SR, 5, amp=0.4), SR),
            "drums": self.audio(tmp_path, "drums", G_MAJOR, amp=0.3),
        }
        segs, _ = processor._detect_chords(stems)
        assert [(s["chord"], s.get("bass")) for s in segs] == [("C:maj", "E")]


class TestProcessReadsChordsFromTheHarmonicStems:
    """The source file is C major; the stems are the only place G major comes from."""

    def stems(self, **named):
        n = 4 * 44100
        return {
            name: np.tile(chord_audio(freqs, 4, sr=44100, amp=amp), (2, 1))[:, :n]
            for name, (freqs, amp) in named.items()
        }

    def run_with(self, mix, tmp_path, monkeypatch, wanted, **named):
        monkeypatch.setattr(processor, "_run_demucs", FakeDemucs(seconds=4, overrides=self.stems(**named)))
        run(mix, tmp_path / "o", stems_to_extract=wanted)
        return json.loads((tmp_path / "o" / "chords.json").read_text(encoding="utf-8"))

    def test_the_chords_come_from_the_stems_that_carry_the_harmony(self, mix, tmp_path, monkeypatch):
        doc = self.run_with(
            mix, tmp_path, monkeypatch, ["vocals", "drums", "guitar"],
            guitar=(G_MAJOR, 0.04), vocals=(C_MAJOR, 0.04), drums=(C_MAJOR, 0.04),
        )
        assert [s["chord"] for s in doc["segments"]] == ["G:maj"]
        assert doc["version"] == 5

    def test_the_source_file_is_read_when_no_harmony_stem_was_extracted(self, mix, tmp_path, monkeypatch):
        doc = self.run_with(mix, tmp_path, monkeypatch, ["vocals", "drums"], vocals=(G_MAJOR, 0.04), drums=(G_MAJOR, 0.04))
        assert [s["chord"] for s in doc["segments"]] == ["C:maj"]


# ─── bass transcription ────────────────────────────────────────────────────

class TestAssignFret:
    def test_open_strings(self):
        for string, midi in enumerate(processor.BASS_OPEN_MIDI):
            assert processor._assign_fret(midi, string, 0) == (string, 0)

    def test_prefers_the_nearest_position_to_the_previous_note(self):
        assert processor._assign_fret(40, 1, 5) == (1, 7)

    def test_prefers_an_open_string_over_a_fret_on_a_lower_one_from_rest(self):
        assert processor._assign_fret(33, 0, 0) == (1, 0)

    def test_the_lowest_playable_note_is_the_open_low_string(self):
        assert processor._assign_fret(28, 0, 0) == (0, 0)

    def test_the_highest_fret_is_reachable_and_one_above_is_not(self):
        top = processor.BASS_OPEN_MIDI[-1] + processor.BASS_MAX_FRET
        string, fret = processor._assign_fret(top, 3, 24)
        assert (string, fret) == (3, processor.BASS_MAX_FRET)

    def test_a_pitch_above_the_range_is_clamped_to_the_last_fret_of_the_low_string(self):
        assert processor._assign_fret(100, 0, 0) == (0, processor.BASS_MAX_FRET)

    def test_a_pitch_below_the_range_falls_back_to_fret_zero(self):
        assert processor._assign_fret(10, 2, 7) == (0, 0)

    def test_always_returns_a_playable_position_for_any_midi_pitch(self):
        for midi in range(0, 128):
            string, fret = processor._assign_fret(midi, 0, 0)
            assert 0 <= string < 4 and 0 <= fret <= processor.BASS_MAX_FRET


class TestTranscribeBass:
    def test_a_sustained_note_becomes_one_note_with_the_right_pitch_and_position(self, tmp_path):
        p = write_wav(tmp_path / "b.wav", sine(55.0, SR, 1.5, amp=0.5), SR)
        notes = processor._transcribe_bass(p)
        assert len(notes) == 1
        n = notes[0]
        assert n["pitch"] == 33 and (n["string"], n["fret"]) == (1, 0)
        assert n["time"] == pytest.approx(0.0, abs=0.15)
        assert n["duration"] == pytest.approx(1.5, abs=0.25)

    def test_two_notes_separated_by_silence_are_two_notes_in_order(self, tmp_path):
        audio = np.concatenate([sine(55.0, SR, 1.0, amp=0.5), np.zeros(int(SR * 0.5), dtype=np.float32), sine(82.41, SR, 1.0, amp=0.5)])
        notes = processor._transcribe_bass(write_wav(tmp_path / "b.wav", audio, SR))
        assert [n["pitch"] for n in notes] == [33, 40]
        assert notes[0]["time"] < notes[1]["time"]
        assert notes[0]["time"] + notes[0]["duration"] <= notes[1]["time"] + 0.05

    def test_a_pitch_change_without_a_gap_starts_a_new_note(self, tmp_path):
        audio = np.concatenate([sine(55.0, SR, 1.0, amp=0.5), sine(73.42, SR, 1.0, amp=0.5)])
        notes = processor._transcribe_bass(write_wav(tmp_path / "b.wav", audio, SR))
        pitches = [n["pitch"] for n in notes]
        assert pitches[0] == 33 and pitches[-1] == 38 and len(pitches) >= 2

    def test_silence_has_no_notes(self, tmp_path):
        p = write_wav(tmp_path / "b.wav", np.zeros(SR * 2, dtype=np.float32), SR)
        assert processor._transcribe_bass(p) == []

    def test_notes_shorter_than_40_ms_are_dropped(self, tmp_path):
        audio = np.concatenate([np.zeros(SR, dtype=np.float32), sine(55.0, SR, 0.02, amp=0.5), np.zeros(SR, dtype=np.float32)])
        assert processor._transcribe_bass(write_wav(tmp_path / "b.wav", audio, SR)) == []

    def test_every_note_is_json_serialisable(self, tmp_path):
        notes = processor._transcribe_bass(write_wav(tmp_path / "b.wav", sine(55.0, SR, 1.0, amp=0.5), SR))
        assert json.loads(json.dumps(notes)) == notes


# ─── key transpose ─────────────────────────────────────────────────────────

def dominant_hz(x, sr):
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x))))
    return np.fft.rfftfreq(len(x), 1 / sr)[int(np.argmax(spectrum))]


class TestPitchShiftSong:
    @pytest.fixture
    def song(self, tmp_path):
        d = tmp_path / "song"
        cache = tmp_path / "cache"
        d.mkdir()
        cache.mkdir()
        return d, cache

    def test_shifts_every_named_stem_by_the_requested_semitones_and_keeps_the_length(self, song):
        d, cache = song
        write_wav(d / "vocals.wav", sine(440, 22050, 1.0), 22050)
        write_wav(d / "bass.wav", sine(110, 22050, 1.0), 22050)
        result = processor.pitch_shift_song(str(d), str(cache), ["vocals", "bass"], 12)
        assert result == {"stems": {"vocals": str(cache / "vocals.wav"), "bass": str(cache / "bass.wav")}}
        for name, f in (("vocals", 880), ("bass", 220)):
            data, sr = sf.read(str(cache / f"{name}.wav"))
            assert sr == 22050 and len(data) == 22050
            assert dominant_hz(data, sr) == pytest.approx(f, rel=0.02)

    def test_a_downward_shift_lowers_the_pitch(self, song):
        d, cache = song
        write_wav(d / "vocals.wav", sine(440, 22050, 1.0), 22050)
        processor.pitch_shift_song(str(d), str(cache), ["vocals"], -12)
        data, sr = sf.read(str(cache / "vocals.wav"))
        assert dominant_hz(data, sr) == pytest.approx(220, rel=0.02)

    def test_stereo_stems_keep_both_channels(self, song):
        d, cache = song
        stereo = np.stack([sine(440, 22050, 1.0), sine(660, 22050, 1.0)], axis=1)
        sf.write(str(d / "other.wav"), stereo, 22050)
        processor.pitch_shift_song(str(d), str(cache), ["other"], 12)
        data, sr = sf.read(str(cache / "other.wav"))
        assert data.shape == stereo.shape
        assert dominant_hz(data[:, 0], sr) == pytest.approx(880, rel=0.02)
        assert dominant_hz(data[:, 1], sr) == pytest.approx(1320, rel=0.02)

    def test_only_the_named_stems_are_processed(self, song):
        d, cache = song
        write_wav(d / "vocals.wav", sine(440, 22050, 0.5), 22050)
        write_wav(d / "drums.wav", sine(100, 22050, 0.5), 22050)
        processor.pitch_shift_song(str(d), str(cache), ["vocals"], 2)
        assert sorted(p.name for p in cache.iterdir()) == ["vocals.wav"]

    def test_progress_is_ordered_and_ends_complete(self, song):
        d, cache = song
        for n in ("vocals", "drums"):
            write_wav(d / f"{n}.wav", sine(220, 22050, 0.5), 22050)
        events = []
        processor.pitch_shift_song(str(d), str(cache), ["vocals", "drums"], 3, on_progress=lambda v, s: events.append((v, s)))
        values = [v for v, _ in events]
        assert values == sorted(values) and events[-1] == (1.0, "complete")
        assert [s for _, s in events] == ["loading-vocals", "shifting-vocals", "loading-drums", "shifting-drums", "complete"]

    def test_a_missing_stem_raises(self, song):
        d, cache = song
        with pytest.raises(Exception):
            processor.pitch_shift_song(str(d), str(cache), ["vocals"], 2)

    def test_an_empty_stem_list_completes_with_nothing(self, song):
        d, cache = song
        assert processor.pitch_shift_song(str(d), str(cache), [], 2) == {"stems": {}}
