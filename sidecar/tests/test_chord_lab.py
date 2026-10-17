"""The chord lab (sidecar/chord_lab): a dev workspace, tested so a sweep can be trusted."""

import json
import sys
from pathlib import Path

import numpy as np
import pytest

import processor
from helpers import write_wav

LAB_DIR = Path(__file__).resolve().parent.parent / "chord_lab"
if str(LAB_DIR) not in sys.path:
    sys.path.insert(0, str(LAB_DIR))

import lab  # noqa: E402

SR = processor.SAMPLE_RATE


def chord_audio(freqs, seconds, amp=0.15):
    t = np.arange(int(SR * seconds)) / SR
    return (sum(np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * 2 * f * t) for f in freqs) * amp).astype(np.float32)


C_MAJOR = (261.63, 329.63, 392.00)
G_MAJOR = (196.00, 246.94, 293.66)


@pytest.fixture
def song(tmp_path):
    folder = tmp_path / "song"
    folder.mkdir()
    write_wav(folder / "guitar.wav", np.concatenate([chord_audio(C_MAJOR, 6), chord_audio(G_MAJOR, 6)]), SR)
    return folder


def write_lab(path, rows):
    path.write_text("".join(f"{a} {b} {c}\n" for a, b, c in rows), encoding="utf-8")
    return path


class TestDetectsLikeTheApp:
    def test_prepared_audio_gives_the_segments_the_pipeline_gives(self, song):
        stems = {"guitar": str(song / "guitar.wav")}
        segments, duration, cents = processor._detect_chords_full(stems)
        prepared = lab.prepare(song)
        assert lab.detect(prepared) == segments
        assert prepared.duration == pytest.approx(duration)
        assert prepared.tuning * 100 == pytest.approx(cents, abs=0.06)

    def test_a_folder_without_audio_is_an_error(self, tmp_path):
        with pytest.raises(FileNotFoundError):
            lab.prepare(tmp_path)


class TestConstants:
    def test_are_restored_after_the_block_even_when_it_fails(self):
        before = processor._SEVENTH_MARGIN
        with pytest.raises(RuntimeError):
            with lab.constants(_SEVENTH_MARGIN=0.5):
                assert processor._SEVENTH_MARGIN == 0.5
                raise RuntimeError
        assert processor._SEVENTH_MARGIN == before

    def test_a_name_the_detector_does_not_have_is_an_error_not_a_silent_no_op(self):
        with pytest.raises(KeyError):
            with lab.constants(_NOT_A_CONSTANT=1):
                pass
        with pytest.raises(KeyError):
            lab.parse_constants(["_NOT_A_CONSTANT=1"])

    def test_parse_gives_numbers(self):
        assert lab.parse_constants(["_SEVENTH_MARGIN=0.1", "_MIN_BEATS=4"]) == {"_SEVENTH_MARGIN": 0.1, "_MIN_BEATS": 4}
        with pytest.raises(ValueError):
            lab.parse_constants(["_SEVENTH_MARGIN"])

    def test_a_constant_that_changes_what_is_read_is_told_apart_from_one_that_changes_the_decoding(self):
        prep, run = lab.split_constants({"_MIN_BEATS": 4, "_SWITCH_COST": 0.2})
        assert prep == {"_MIN_BEATS": 4} and run == {"_SWITCH_COST": 0.2}

    def test_a_decoding_constant_changes_the_result_on_prepared_audio(self, song):
        prepared = lab.prepare(song)
        plain = lab.detect(prepared)
        with_big_margin = lab.detect(prepared, _SEVENTH_MARGIN=0.0, _SWITCH_COST=0.0, _SWITCH_COST_RELATED=0.0,
                                     _SWITCH_COST_SAME_ROOT=0.0)
        assert [s["chord"] for s in plain] == ["C:maj", "G:maj"]
        assert with_big_margin


class TestDataSets:
    def make(self, tmp_path, monkeypatch):
        monkeypatch.setattr(lab, "DATASETS", tmp_path / "datasets")
        folder = lab.DATASETS / "demo"
        folder.mkdir(parents=True)
        (folder / "manifest.json").write_text(json.dumps({
            "description": "demo", "align": True,
            "songs": [{"song_dir": "a", "ref": "a.lab"}, {"name": "B", "song_dir": "~/x", "ref": "b.lab"}],
        }), encoding="utf-8")
        return folder

    def test_paths_are_resolved_against_the_manifest_and_home(self, tmp_path, monkeypatch):
        folder = self.make(tmp_path, monkeypatch)
        data = lab.load_set("demo")
        assert data.align is True and data.description == "demo"
        assert data.songs[0]["name"] == "a"
        assert data.songs[0]["song_dir"] == str((folder / "a").resolve())
        assert data.songs[1]["song_dir"] == str((Path.home() / "x").resolve())

    def test_a_missing_set_names_the_ones_there_are(self, tmp_path, monkeypatch):
        self.make(tmp_path, monkeypatch)
        with pytest.raises(SystemExit, match="demo"):
            lab.load_set("nope")

    def test_a_song_is_found_by_part_of_its_name_and_only_when_unambiguous(self, tmp_path, monkeypatch):
        self.make(tmp_path, monkeypatch)
        data = lab.load_set("demo")
        assert lab.find_song(data, "B")["name"] == "B"
        with pytest.raises(SystemExit):
            lab.find_song(data, "zzz")

    def test_import_copies_charts_and_audio_and_the_result_loads(self, tmp_path, monkeypatch, song):
        import import_set
        monkeypatch.setattr(lab, "DATASETS", tmp_path / "datasets")
        source = tmp_path / "src"
        source.mkdir()
        write_lab(source / "s.lab", [(0, 6, "C:maj")])
        (source / "manifest.json").write_text(json.dumps([{"name": "S", "song_dir": str(song), "ref": "s.lab"}]), encoding="utf-8")
        assert import_set.main([str(source / "manifest.json"), "mine", "--copy-audio", "--align"]) == 0
        data = lab.load_set("mine")
        assert data.align and [s["name"] for s in data.songs] == ["S"]
        assert (lab.DATASETS / "mine" / "song" / "guitar.wav").exists()
        assert Path(data.songs[0]["ref"]).exists()


class TestScoring:
    def test_a_correct_chart_scores_full_and_a_wrong_one_does_not(self, song, tmp_path):
        good = write_lab(tmp_path / "good.lab", [(0, 6, "C:maj"), (6, 12, "G:maj")])
        bad = write_lab(tmp_path / "bad.lab", [(0, 6, "D:min"), (6, 12, "A:min")])
        entry = {"name": "s", "song_dir": str(song)}
        prepared = lab.prepare(song)
        right = lab.score_song({**entry, "ref": str(good)}, {}, False, prepared)
        wrong = lab.score_song({**entry, "ref": str(bad)}, {}, False, prepared)
        assert right["levels"]["majmin"]["score"] > 0.9
        assert wrong["levels"]["majmin"]["score"] < 0.1

    def test_align_finds_a_chart_that_starts_late(self, song, tmp_path):
        late = write_lab(tmp_path / "late.lab", [(2, 8, "C:maj"), (8, 14, "G:maj")])
        entry = {"name": "s", "song_dir": str(song), "ref": str(late)}
        result = lab.score_song(entry, {}, True)
        assert result["offset"] == pytest.approx(2.0, abs=0.3)
        assert result["levels"]["majmin"]["score"] > 0.8

    def test_the_reference_is_moved_onto_the_audio_not_the_detection(self, song, tmp_path):
        late = write_lab(tmp_path / "late.lab", [(2, 8, "C:maj"), (8, 14, "G:maj")])
        entry = {"name": "s", "ref": str(late)}
        detected = lab.detect(lab.prepare(song))
        moved, offset = lab.aligned_reference(entry, detected, True)
        assert offset == pytest.approx(2.0, abs=0.3)
        assert moved[0]["start"] == pytest.approx(0.0, abs=0.3)
        same, zero = lab.aligned_reference(entry, detected, False)
        assert zero == 0.0 and same[0]["start"] == 2.0


class TestBootstrap:
    def result(self, score, seconds):
        return {"levels": {"root": {"score": score, "scored_seconds": seconds}}}

    def test_the_weighted_score_follows_the_seconds(self):
        assert lab.weighted([self.result(1.0, 30), self.result(0.0, 10)], "root") == pytest.approx(0.75)

    def test_the_interval_holds_the_score_and_is_repeatable(self):
        results = [self.result(s, 100) for s in (0.4, 0.5, 0.6, 0.7, 0.8)]
        low, high = lab.bootstrap(results, "root")
        assert low < lab.weighted(results, "root") < high
        assert (low, high) == lab.bootstrap(results, "root")

    def test_songs_that_agree_give_a_narrow_interval_and_songs_that_differ_a_wide_one(self):
        same = lab.bootstrap([self.result(0.6, 100)] * 6, "root")
        spread = lab.bootstrap([self.result(s, 100) for s in (0.1, 0.9, 0.2, 0.8, 0.3, 0.7)], "root")
        assert same[1] - same[0] < 1e-9
        assert spread[1] - spread[0] > 0.2

    def test_one_song_has_no_interval_to_speak_of(self):
        assert lab.bootstrap([self.result(0.5, 10)], "root") == (0.5, 0.5)


class TestSweep:
    def test_params_are_crossed(self):
        import sweep
        combos = sweep.parse_params(["_SEVENTH_MARGIN=0.02,0.07", "_KEY_BONUS=0,0.02"])
        assert len(combos) == 4
        assert {"_SEVENTH_MARGIN": 0.07, "_KEY_BONUS": 0} in combos

    def test_a_param_without_values_is_an_error(self):
        import sweep
        with pytest.raises(SystemExit):
            sweep.parse_params(["_SEVENTH_MARGIN"])

    def test_tuning_and_held_out_sets_must_differ(self):
        import sweep
        with pytest.raises(SystemExit):
            sweep.main(["--tune", "a", "--heldout", "a", "--param", "_KEY_BONUS=0"])


class TestSonify:
    def test_chords_are_voiced_from_the_chord_alone_with_the_slash_bass_low(self):
        import sonify
        assert sonify.voicing("C:maj", None) == [36, 60, 64, 67]
        assert sonify.voicing("A:min7", "C") == [36, 69, 60, 64, 67]
        assert sonify.voicing("N", None) == []
        assert sonify.voicing("D:sus4", None) == []

    def test_a_rendered_chord_sounds_at_its_pitches_detuned_by_the_tuning(self):
        import sonify
        audio = sonify.render([{"start": 0.0, "end": 2.0, "chord": "A:min"}], 2.0, 50.0)
        spectrum = np.abs(np.fft.rfft(audio * np.hanning(len(audio))))
        freqs = np.fft.rfftfreq(len(audio), 1 / SR)
        band = (freqs > 400) & (freqs < 1000)
        peak = freqs[band][np.argmax(spectrum[band])]
        expected = [440.0 * 2 ** (50 / 1200) * 2 ** (m / 12) for m in (0, 3, 7)]
        assert min(abs(peak - e) for e in expected) < 2.0

    def test_silence_stays_silent(self):
        import sonify
        assert not sonify.render([{"start": 0.0, "end": 1.0, "chord": "N"}], 1.0, 0.0).any()


class TestVisualize:
    def test_agreement_tells_exact_root_only_and_wrong_apart(self):
        pytest.importorskip("matplotlib")
        import matplotlib
        matplotlib.use("Agg")
        import visualize
        reference = [{"start": 0, "end": 4, "chord": "C:maj"}, {"start": 4, "end": 8, "chord": "N"}]
        detected = [{"start": 0, "end": 1, "chord": "C:maj7"}, {"start": 1, "end": 2, "chord": "C:min"},
                    {"start": 2, "end": 3, "chord": "A:min"}, {"start": 4, "end": 5, "chord": "C:maj"}]
        times = np.array([0.5, 1.5, 2.5, 3.5, 4.5])
        assert visualize.agreement(detected, reference, times).tolist() == [1, 2, 3, 3, 0]
