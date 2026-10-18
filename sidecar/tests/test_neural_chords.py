"""The optional neural chord engine (sidecar/neural_chords): vocabulary and segmentation need no torch, the model tests need the weights."""

import os
import sys
from pathlib import Path

import numpy as np
import pytest

import processor
from helpers import write_wav
from neural_chords import engine, labels

SR = processor.SAMPLE_RATE
WEIGHTS = Path(__file__).resolve().parent.parent / "vendor" / "btc" / engine.WEIGHTS_NAME


def class_of(root: int, quality: str) -> int:
    return root * len(labels.MODEL_QUALITIES) + labels.MODEL_QUALITIES.index(quality)


def one_hot(*classes, weights=None):
    out = np.zeros(labels.NUM_CLASSES)
    for i, c in enumerate(classes):
        out[c] = 1.0 if weights is None else weights[i]
    return out


class TestVocabulary:
    def test_every_class_folds_to_exactly_one_chord_the_app_can_write(self):
        matrix = labels.folding_matrix()
        assert matrix.shape == (labels.NUM_CLASSES, len(labels.APP_LABELS))
        assert (matrix.sum(axis=1) == 1).all()

    def test_the_app_labels_are_all_in_the_apps_vocabulary(self):
        for label in labels.APP_LABELS[:-1]:
            root, quality = label.split(":")
            assert root in labels.ROOTS and quality in labels.APP_QUALITIES
        assert labels.APP_LABELS[-1] == "N"
        assert len(labels.APP_LABELS) == 12 * 10 + 1

    def test_the_app_vocabulary_is_the_one_the_rust_side_accepts(self):
        rust = (Path(__file__).resolve().parent.parent.parent / "src-tauri" / "src" / "library.rs").read_text(encoding="utf-8")
        line = next(l for l in rust.splitlines() if l.startswith("const CHORD_QUALITIES"))
        accepted = [q.strip().strip('"') for q in line.split("=", 1)[1].strip().rstrip(";").strip("[]").split(",")]
        assert sorted(labels.APP_QUALITIES) == sorted(accepted)

    @pytest.mark.parametrize("model_quality,app_quality", [
        ("maj", "maj"), ("min", "min"), ("7", "7"), ("maj7", "maj7"), ("min7", "min7"), ("sus2", "sus2"), ("sus4", "sus4"),
        ("dim", "dim"), ("aug", "aug"), ("maj6", "6"), ("min6", "min"), ("minmaj7", "min"), ("dim7", "dim"), ("hdim7", "min7"),
    ])
    def test_each_model_quality_folds_as_documented(self, model_quality, app_quality):
        folded = labels.fold_probabilities(one_hot(class_of(7, model_quality))[None, :])[0]
        assert labels.APP_LABELS[int(folded.argmax())] == f"G:{app_quality}"

    def test_unknown_and_no_chord_are_both_no_chord(self):
        for index in (labels.UNKNOWN, labels.NO_CHORD):
            assert int(labels.fold_probabilities(one_hot(index)[None, :])[0].argmax()) == labels.NO_CHORD_INDEX


class TestSegments:
    UNIT = 0.1

    def frames(self, *spans):
        """spans: (a class, or a list of (class, probability), and a number of frames)"""
        rows = []
        for what, n in spans:
            row = one_hot(what) if isinstance(what, int) else one_hot(*[c for c, _ in what], weights=[w for _, w in what])
            rows += [row] * n
        return np.array(rows)

    def test_runs_become_segments_with_times_and_a_gap_for_no_chord(self):
        probs = self.frames((class_of(0, "maj"), 10), (labels.NO_CHORD, 5), (class_of(9, "min7"), 10))
        segs = labels.segments_from_probabilities(probs, self.UNIT)
        assert [(s["chord"], s["start"], s["end"]) for s in segs] == [("C:maj", 0.0, 1.0), ("A:min7", 1.5, 2.5)]

    def test_classes_that_fold_to_the_same_chord_do_not_split_a_segment(self):
        probs = self.frames((class_of(2, "min"), 4), (class_of(2, "min6"), 4), (class_of(2, "minmaj7"), 4))
        segs = labels.segments_from_probabilities(probs, self.UNIT)
        assert [(s["chord"], s["end"]) for s in segs] == [("D:min", 1.2)]
        assert segs[0]["confidence"] == 1.0

    def test_the_decision_is_made_after_folding_so_a_split_vote_still_wins(self):
        # 40% min, 35% min6, 25% maj: D minor wins as a chord although "min" alone has less than the 75% it earns together
        probs = self.frames(([(class_of(2, "min"), 0.4), (class_of(2, "min6"), 0.35), (class_of(2, "maj"), 0.25)], 5))
        seg = labels.segments_from_probabilities(probs, self.UNIT)[0]
        assert seg["chord"] == "D:min" and seg["confidence"] == pytest.approx(0.75, abs=0.01)
        assert seg["alternatives"][0] == {"chord": "D:maj", "fit": 0.25}

    def test_confidence_is_the_mean_probability_and_alternatives_are_other_chords(self):
        probs = self.frames(([(class_of(0, "maj"), 0.9), (class_of(7, "maj"), 0.1)], 5), ([(class_of(0, "maj"), 0.7), (class_of(9, "min"), 0.3)], 5))
        seg = labels.segments_from_probabilities(probs, self.UNIT)[0]
        assert seg["confidence"] == pytest.approx(0.8)
        names = [a["chord"] for a in seg["alternatives"]]
        assert "C:maj" not in names and "N" not in names and len(names) == len(set(names)) <= labels.ALTERNATIVES
        assert names[0] in ("A:min", "G:maj")

    def test_a_segment_has_the_fields_of_the_classical_detectors(self):
        seg = labels.segments_from_probabilities(self.frames((class_of(4, "7"), 6)), self.UNIT)[0]
        assert set(seg) == {"start", "end", "chord", "confidence", "alternatives"}
        assert all(set(a) == {"chord", "fit"} for a in seg["alternatives"])

    def test_nothing_in_nothing_out(self):
        assert labels.segments_from_probabilities(np.zeros((0, labels.NUM_CLASSES)), self.UNIT) == []
        assert labels.segments_from_probabilities(self.frames((labels.NO_CHORD, 8)), self.UNIT) == []


class TestEngineSelection:
    def test_classical_is_the_default(self, monkeypatch, tmp_path):
        monkeypatch.delenv("SPS_CHORD_ENGINE", raising=False)
        monkeypatch.setattr(processor, "_CHORD_ENGINE_FILE", str(tmp_path / "none"))
        assert processor._chord_engine() == "classic"

    def test_the_environment_selects_it_and_wins_over_the_file(self, monkeypatch, tmp_path):
        monkeypatch.setenv("SPS_CHORD_ENGINE", " Neural ")
        assert processor._chord_engine() == "neural"
        monkeypatch.setenv("SPS_CHORD_ENGINE", "classic")
        monkeypatch.setattr(processor, "_CHORD_ENGINE_FILE", str(tmp_path / "chord_engine"))
        (tmp_path / "chord_engine").write_text("neural\n", encoding="utf-8")
        assert processor._chord_engine() == "classic"

    def test_a_file_selects_it_when_the_environment_is_silent(self, monkeypatch, tmp_path):
        monkeypatch.delenv("SPS_CHORD_ENGINE", raising=False)
        monkeypatch.setattr(processor, "_CHORD_ENGINE_FILE", str(tmp_path / "chord_engine"))
        (tmp_path / "chord_engine").write_text("neural\n", encoding="utf-8")
        assert processor._chord_engine() == "neural"

    def test_an_unknown_engine_is_an_error_not_a_silent_default(self, monkeypatch):
        monkeypatch.setenv("SPS_CHORD_ENGINE", "magic")
        with pytest.raises(ValueError, match="classic, neural"):
            processor._chord_engine()


def segments_of(*chords):
    out = processor.ChordSegments(
        {"start": float(i), "end": float(i + 1), "chord": c, "confidence": 0.9, "alternatives": []} for i, c in enumerate(chords))
    out.engine, out.model = "neural", "test-model"
    return out


class TestPipeline:
    def stems(self, tmp_path):
        t = np.arange(SR * 6) / SR
        tone = sum(np.sin(2 * np.pi * f * t) for f in (261.63, 329.63, 392.0)).astype(np.float32) * 0.1
        return {"guitar": write_wav(tmp_path / "guitar.wav", tone, SR)}

    def test_the_neural_result_is_used_and_recorded_in_the_document(self, monkeypatch, tmp_path):
        monkeypatch.setenv("SPS_CHORD_ENGINE", "neural")
        monkeypatch.setattr(processor, "_neural_chords", lambda mix, bass, tuning: segments_of("C:maj", "G:maj"))
        segments, duration, cents = processor._detect_chords_full(self.stems(tmp_path))
        doc = processor._chords_document(segments, duration, cents)
        assert [s["chord"] for s in doc["segments"]] == ["C:maj", "G:maj"]
        assert doc["engine"] == "neural" and doc["model"] == "test-model" and doc["version"] == processor.CHORDS_FORMAT_VERSION

    def test_the_classical_document_is_unchanged(self, monkeypatch, tmp_path):
        monkeypatch.delenv("SPS_CHORD_ENGINE", raising=False)
        monkeypatch.setattr(processor, "_CHORD_ENGINE_FILE", str(tmp_path / "none"))
        segments, duration, cents = processor._detect_chords_full(self.stems(tmp_path))
        assert set(processor._chords_document(segments, duration, cents)) == {"version", "duration", "tuning", "segments"}

    def test_a_failing_neural_engine_falls_back_to_the_classical_detector_and_says_so(self, monkeypatch, tmp_path, capsys):
        monkeypatch.setenv("SPS_CHORD_ENGINE", "neural")

        def boom(mix, bass, tuning):
            raise engine.WeightsNotFound("no weights here")

        monkeypatch.setattr(processor, "_neural_chords", boom)
        segments, _, _ = processor._detect_chords_full(self.stems(tmp_path))
        assert segments and getattr(segments, "engine", "classic") == "classic"
        assert "neural chord engine failed" in capsys.readouterr().err

    def test_missing_weights_are_reported_with_what_to_do(self, monkeypatch, tmp_path):
        monkeypatch.setattr(engine, "weights_search_paths", lambda: [tmp_path / "nothing.pt"])
        with pytest.raises(engine.WeightsNotFound, match="fetch_btc.py"):
            engine.find_weights()

    def test_a_file_that_is_not_the_pinned_model_is_refused_before_anything_is_loaded(self, monkeypatch, tmp_path):
        impostor = tmp_path / engine.WEIGHTS_NAME
        impostor.write_bytes(b"not a checkpoint")
        monkeypatch.delenv("SPS_BTC_WEIGHTS", raising=False)
        monkeypatch.setattr(engine, "find_weights", lambda: impostor)
        with pytest.raises(ValueError, match="refusing"):
            engine.NeuralChords.load()

    def test_the_checksum_helper_hashes_the_file(self, tmp_path):
        (tmp_path / "a").write_bytes(b"abc")
        assert engine.sha256_of(tmp_path / "a") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


class TestBassNotes:
    def bass(self, freq):
        t = np.arange(SR * 4) / SR
        return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)

    def test_the_bass_stem_makes_a_slash_chord_of_a_neural_segment(self):
        segs = [{"start": 0.0, "end": 3.0, "chord": "C:maj"}]
        processor._add_bass_notes(segs, self.bass(82.41), 0.0)
        assert segs[0]["bass"] == "E"

    def test_the_root_in_the_bass_is_not_a_slash_chord(self):
        segs = [{"start": 0.0, "end": 3.0, "chord": "C:maj"}]
        processor._add_bass_notes(segs, self.bass(65.41), 0.0)
        assert "bass" not in segs[0]

    def test_the_qualities_only_the_neural_engine_writes_do_not_break_the_slash_rule(self):
        for chord, bass_freq, note in (("C:sus4", 87.31, "F"), ("C:dim", 92.5, "F#"), ("C:aug", 103.83, "G#"), ("C:6", 110.0, "A"), ("C:sus2", 73.42, "D")):
            segs = [{"start": 0.0, "end": 3.0, "chord": chord}]
            processor._add_bass_notes(segs, self.bass(bass_freq), 0.0)
            assert segs[0].get("bass") == note, chord

    def test_no_bass_stem_adds_nothing(self):
        segs = [{"start": 0.0, "end": 3.0, "chord": "C:maj"}]
        processor._add_bass_notes(segs, None, 0.0)
        assert "bass" not in segs[0]


@pytest.mark.slow
@pytest.mark.skipif(not WEIGHTS.is_file(), reason="run fetch_btc.py to download the neural model's weights")
class TestRealModel:
    @pytest.fixture(scope="class")
    def model(self):
        pytest.importorskip("torch")
        os.environ.pop("SPS_BTC_WEIGHTS", None)
        return engine.NeuralChords.load()

    def progression(self):
        def chord(freqs, seconds=4):
            t = np.arange(int(SR * seconds)) / SR
            return sum(np.sin(2 * np.pi * f * t) + 0.5 * np.sin(2 * np.pi * 2 * f * t) + 0.25 * np.sin(2 * np.pi * 3 * f * t) for f in freqs).astype(np.float32) * 0.08

        return np.concatenate([chord((130.81, 164.81, 196.0, 261.63)), chord((98.0, 123.47, 146.83, 196.0)), chord((110.0, 130.81, 164.81, 220.0))])

    def test_the_pretrained_weights_load_strictly_and_produce_app_chords(self, model):
        segs = model.detect(self.progression())
        assert segs and segs[0]["start"] >= 0
        for seg in segs:
            assert seg["chord"].split(":")[1] in labels.APP_QUALITIES and 0.0 <= seg["confidence"] <= 1.0
        assert all(a["end"] <= b["start"] + 1e-6 for a, b in zip(segs, segs[1:]))

    def test_the_same_audio_gives_the_same_chords_every_time_and_with_any_thread_count(self, model):
        import torch

        audio = self.progression()
        first = model.detect(audio)
        assert model.detect(audio) == first
        old = torch.get_num_threads()
        try:
            torch.set_num_threads(1)
            single = model.detect(audio)
        finally:
            torch.set_num_threads(old)
        assert [(s["start"], s["end"], s["chord"]) for s in single] == [(s["start"], s["end"], s["chord"]) for s in first]

    def test_the_pipeline_runs_it_end_to_end_and_records_the_engine(self, monkeypatch, tmp_path):
        pytest.importorskip("torch")
        monkeypatch.setenv("SPS_CHORD_ENGINE", "neural")
        monkeypatch.setattr(processor, "_neural_engine", None)
        stems = {"guitar": write_wav(tmp_path / "guitar.wav", self.progression(), SR)}
        segments, duration, cents = processor._detect_chords_full(stems)
        doc = processor._chords_document(segments, duration, cents)
        assert doc["engine"] == "neural" and doc["model"] == engine.MODEL_ID and doc["segments"]
