import json

import pytest

import chord_eval
from chord_eval import evaluate, parse_label, read_lab, score, simplify


def seg(start, end, chord):
    return {"start": start, "end": end, "chord": chord}


class TestParseLabel:
    def test_harte_and_plain_names_agree(self):
        assert parse_label("A:min7") == (9, "min7")
        assert simplify("Am7", "sevenths") == simplify("A:min7", "sevenths") == "A:min7"
        assert parse_label("C#:maj") == (1, "maj")
        assert simplify("C#", "sevenths") == simplify("C#:maj", "sevenths") == "C#:maj"

    def test_flats_and_slash_bass(self):
        assert parse_label("Bb:7/5") == (10, "7")
        assert parse_label("Ab") == (8, "")

    def test_no_chord(self):
        for label in ("N", "X", ""):
            assert parse_label(label) is None

    def test_garbage_is_an_error_not_a_silent_miss(self):
        with pytest.raises(ValueError):
            parse_label("H:maj")
        with pytest.raises(ValueError):
            parse_label("hello")


class TestSimplify:
    def test_levels_drop_detail(self):
        assert simplify("C:maj7", "root") == "C"
        assert simplify("C:maj7", "majmin") == "C:maj"
        assert simplify("C:maj7", "sevenths") == "C:maj7"
        assert simplify("A:min9", "sevenths") == "A:min7"
        assert simplify("G:7", "majmin") == "G:maj"

    def test_sus_dim_aug_have_no_triad_reading(self):
        for quality in ("sus4", "dim", "aug"):
            assert simplify(f"D:{quality}", "majmin") is None
            assert simplify(f"D:{quality}", "sevenths") is None
            assert simplify(f"D:{quality}", "root") == "D"

    def test_no_chord_at_every_level(self):
        assert [simplify("N", level) for level in chord_eval.LEVELS] == ["N", "N", "N"]


class TestScore:
    def test_identical_charts_score_one(self):
        chart = [seg(0, 2, "C:maj"), seg(2, 4, "G:7")]
        assert score(chart, chart, "sevenths")["score"] == 1.0

    def test_partial_overlap_is_weighted_by_time(self):
        ref = [seg(0, 4, "C:maj")]
        est = [seg(0, 3, "C:maj"), seg(3, 4, "G:maj")]
        assert score(ref, est, "majmin")["score"] == pytest.approx(0.75)

    def test_a_late_change_costs_exactly_its_lateness(self):
        ref = [seg(0, 2, "C:maj"), seg(2, 4, "F:maj")]
        est = [seg(0, 2.5, "C:maj"), seg(2.5, 4, "F:maj")]
        assert score(ref, est, "majmin")["score"] == pytest.approx(0.875)

    def test_levels_forgive_what_they_do_not_distinguish(self):
        ref = [seg(0, 4, "C:maj7")]
        est = [seg(0, 4, "C:maj")]
        assert score(ref, est, "root")["score"] == 1.0
        assert score(ref, est, "majmin")["score"] == 1.0
        assert score(ref, est, "sevenths")["score"] == 0.0

    def test_unsayable_reference_time_leaves_the_denominator(self):
        ref = [seg(0, 2, "C:maj"), seg(2, 4, "D:sus4")]
        est = [seg(0, 2, "C:maj"), seg(2, 4, "D:maj")]
        result = score(ref, est, "majmin")
        assert result["scored_seconds"] == pytest.approx(2.0)
        assert result["score"] == 1.0

    def test_a_gap_in_the_estimate_reads_as_no_chord(self):
        ref = [seg(0, 2, "C:maj"), seg(2, 4, "N")]
        est = [seg(0, 2, "C:maj")]
        assert score(ref, est, "root")["score"] == 1.0

    def test_estimate_running_short_loses_the_rest(self):
        ref = [seg(0, 4, "C:maj")]
        est = [seg(0, 1, "C:maj")]
        assert score(ref, est, "root")["score"] == pytest.approx(0.25)

    def test_duration_caps_the_scored_span(self):
        ref = [seg(0, 10, "C:maj")]
        est = [seg(0, 5, "C:maj")]
        assert score(ref, est, "root", duration=5)["score"] == 1.0

    def test_confusions_name_the_mistake(self):
        ref = [seg(0, 4, "C:maj")]
        est = [seg(0, 4, "A:min")]
        (want, got), seconds = score(ref, est, "majmin")["confusions"][0]
        assert (want, got, seconds) == ("C:maj", "A:min", pytest.approx(4.0))

    def test_unknown_level_is_rejected(self):
        with pytest.raises(ValueError):
            score([], [], "triads")


class TestFiles:
    def test_read_lab_accepts_comments_and_both_label_styles(self, tmp_path):
        lab = tmp_path / "song.lab"
        lab.write_text("# a comment\n0.0 1.5 C:maj\n1.5 3.0 Am7\n3.0 4.0 N\n", encoding="utf-8")
        assert [s["chord"] for s in read_lab(lab)] == ["C:maj", "Am7", "N"]

    def test_read_lab_rejects_a_short_line(self, tmp_path):
        lab = tmp_path / "bad.lab"
        lab.write_text("0.0 1.5\n", encoding="utf-8")
        with pytest.raises(ValueError, match="bad.lab:1"):
            read_lab(lab)

    def test_evaluate_reports_segment_counts(self):
        ref = [seg(0, 2, "C:maj"), seg(2, 4, "G:maj")]
        est = [seg(0, 1, "C:maj"), seg(1, 2, "C:maj"), seg(2, 4, "G:maj")]
        result = evaluate(ref, est)
        assert (result["reference_segments"], result["estimated_segments"]) == (2, 3)

    def test_cli_scores_a_stored_chords_json(self, tmp_path, capsys):
        song = tmp_path / "song"
        song.mkdir()
        (song / "chords.json").write_text(
            json.dumps({"version": 4, "duration": 4, "segments": [seg(0, 2, "C:maj"), seg(2, 4, "G:maj")]}),
            encoding="utf-8",
        )
        (tmp_path / "song.lab").write_text("0 2 C:maj\n2 4 G:maj\n", encoding="utf-8")
        assert chord_eval.main(["--song-dir", str(song), "--ref", str(tmp_path / "song.lab")]) == 0
        assert "100.0%" in capsys.readouterr().out

    def test_cli_needs_a_chart(self):
        with pytest.raises(SystemExit):
            chord_eval.main([])

    def test_set_rejects_a_constant_that_does_not_exist(self):
        with pytest.raises(KeyError):
            chord_eval.detect("nowhere", {"_NOT_A_CONSTANT": 1.0})
