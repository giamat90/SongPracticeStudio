"""align_lyrics: audio in, lyric text in, per-line and per-word times out."""

import json

import numpy as np
import pytest

import lyrics
from helpers import write_wav, sine
from lyrics_helpers import ScriptedAligner

TEXT = "hello world\nsing it loud"
STARTS = [1.0, 1.8, 3.0, 3.4, 3.9]


@pytest.fixture
def vocals(tmp_path):
    return write_wav(tmp_path / "vocals.wav", sine(220, 16000, 6.0, amp=0.3), 16000)


def run(vocals, text=TEXT, starts=STARTS, **kw):
    keys = ("peak", "letter_frames", "noise", "extra_events")
    aligner = ScriptedAligner(text, starts, **{k: kw.pop(k) for k in keys if k in kw})
    return aligner, lyrics.align_lyrics(vocals, text, aligner=aligner, **kw)


class TestTimeline:
    def test_every_word_lands_on_the_time_its_letters_were_emitted(self, vocals):
        _, result = run(vocals)
        words = [w for line in result["lines"] for w in line["words"]]
        assert [w["text"] for w in words] == ["hello", "world", "sing", "it", "loud"]
        for word, expected in zip(words, STARTS):
            assert word["start"] == pytest.approx(expected, abs=0.03)

    def test_a_line_runs_from_its_first_word_to_the_end_of_its_last(self, vocals):
        _, result = run(vocals)
        first, second = result["lines"]
        assert first["text"] == "hello world"
        assert first["start"] == pytest.approx(1.0, abs=0.03)
        assert first["end"] == pytest.approx(first["words"][-1]["end"])
        assert second["start"] == pytest.approx(3.0, abs=0.03)
        assert first["end"] <= second["start"]

    def test_word_ends_never_precede_their_starts(self, vocals):
        _, result = run(vocals, letter_frames=3)
        for line in result["lines"]:
            for w in line["words"]:
                assert w["end"] >= w["start"]
            assert line["end"] >= line["start"]

    def test_a_longer_letter_hold_makes_a_longer_word(self, vocals):
        _, short = run(vocals, letter_frames=1)
        _, long = run(vocals, letter_frames=5)
        s = short["lines"][0]["words"][0]
        l = long["lines"][0]["words"][0]
        assert (l["end"] - l["start"]) > (s["end"] - s["start"])

    def test_words_that_cannot_be_sung_sit_between_their_neighbours(self, vocals):
        text = "hello — world"
        _, result = run(vocals, text, [1.0, 2.0])
        hello, dash, world = result["lines"][0]["words"]
        assert dash["text"] == "—"
        assert hello["end"] <= dash["start"] <= world["start"]
        assert dash["score"] == 0

    def test_a_leading_unsingable_word_borrows_the_next_start(self, vocals):
        _, result = run(vocals, "— hello", [2.0])
        dash, hello = result["lines"][0]["words"]
        assert dash["start"] == pytest.approx(hello["start"])

    def test_repeated_lines_are_placed_one_after_the_other(self, vocals):
        text = "la la\nla la"
        _, result = run(vocals, text, [1.0, 1.5, 3.0, 3.5])
        a, b = result["lines"]
        assert a["start"] < a["end"] <= b["start"] < b["end"]

    def test_section_markers_never_reach_the_output(self, vocals):
        text = "[Chorus]\nhello world"
        _, result = run(vocals, text, [1.0, 1.8])
        assert [l["text"] for l in result["lines"]] == ["hello world"]


class TestAudioHandling:
    def test_the_model_receives_mono_audio_at_its_own_rate(self, tmp_path):
        stereo = np.stack([sine(220, 44100, 4.0, 0.3), sine(330, 44100, 4.0, 0.3)], axis=1)
        path = write_wav(tmp_path / "stereo.wav", stereo, 44100)
        aligner, _ = run(path, "hi there", [0.5, 1.0])
        assert aligner.seen_audio.ndim == 1
        assert len(aligner.seen_audio) == pytest.approx(4.0 * 16000, abs=2)
        assert aligner.seen_audio.dtype == np.float32

    def test_the_targets_are_the_normalised_letters_in_order(self, vocals):
        aligner, _ = run(vocals, "Hi, you!", [1.0, 2.0])
        ids = aligner.char_ids
        assert aligner.seen_targets == [ids["h"], ids["i"], ids["y"], ids["o"], ids["u"]]


class TestResultShape:
    def test_the_result_is_plain_json(self, vocals):
        _, result = run(vocals)
        assert json.loads(json.dumps(result)) == result

    def test_reports_the_engine_and_word_counts(self, vocals):
        _, result = run(vocals)
        assert result["aligner"] == "scripted"
        assert result["totalWords"] == 5
        assert result["alignedWords"] == 5

    def test_unsingable_words_are_counted_as_unaligned(self, vocals):
        _, result = run(vocals, "hello — world", [1.0, 2.0])
        assert (result["alignedWords"], result["totalWords"]) == (2, 3)

    def test_a_clean_alignment_carries_no_warning(self, vocals):
        _, result = run(vocals, peak=0.9)
        assert result["warning"] is None
        assert result["meanScore"] == pytest.approx(0.9, abs=0.05)

    def test_a_poor_match_warns_the_lyrics_may_not_fit_the_recording(self, vocals):
        _, result = run(vocals, peak=0.12)
        assert result["warning"] and "match" in result["warning"].lower()

    def test_far_more_singing_than_text_warns_the_lyrics_may_be_incomplete(self, vocals):
        _, result = run(vocals, extra_events=60)
        assert result["evidenceRatio"] > 3.5
        assert "incomplete" in result["warning"]

    def test_a_normal_alignment_reports_a_ratio_near_one(self, vocals):
        _, result = run(vocals)
        assert result["evidenceRatio"] == pytest.approx(1.0, abs=0.35)


class TestAssessAlignment:
    def test_a_healthy_alignment_has_no_warning(self):
        assert lyrics.assess_alignment(0.4, 1.5, 100, 100) is None

    def test_the_highest_ratio_seen_on_correct_lyrics_is_not_flagged(self):
        assert lyrics.assess_alignment(0.6, 2.94, 183, 183) is None

    def test_missing_sections(self):
        assert "incomplete" in lyrics.assess_alignment(0.6, 4.0, 100, 100)

    def test_surplus_text(self):
        assert "longer than what is sung" in lyrics.assess_alignment(0.4, 0.3, 100, 100)

    def test_low_confidence(self):
        assert "match" in lyrics.assess_alignment(0.1, 1.5, 100, 100)

    def test_most_words_unplaceable(self):
        assert "match" in lyrics.assess_alignment(0.5, 1.5, 30, 100)


class TestProgress:
    def test_is_monotonic_and_ends_at_one(self, vocals):
        seen = []
        run(vocals, on_progress=lambda value, stage: seen.append((value, stage)))
        values = [v for v, _ in seen]
        assert values == sorted(values)
        assert values[-1] == 1.0
        assert all(0.0 <= v <= 1.0 for v in values)
        assert all(isinstance(stage, str) and stage for _, stage in seen)


class TestFailures:
    def test_missing_vocals_file(self, tmp_path):
        with pytest.raises(lyrics.LyricsError, match="not found"):
            lyrics.align_lyrics(str(tmp_path / "nope.wav"), TEXT, aligner=ScriptedAligner(TEXT, STARTS))

    def test_empty_lyrics(self, vocals):
        with pytest.raises(lyrics.LyricsError, match="no words"):
            lyrics.align_lyrics(vocals, "  \n ", aligner=ScriptedAligner("", []))

    def test_only_markers_counts_as_empty(self, vocals):
        with pytest.raises(lyrics.LyricsError, match="no words"):
            lyrics.align_lyrics(vocals, "[Instrumental]", aligner=ScriptedAligner("", []))

    def test_lyrics_with_nothing_the_model_can_pronounce(self, vocals):
        with pytest.raises(lyrics.LyricsError, match="letters"):
            lyrics.align_lyrics(vocals, "1 2 3 — !!!", aligner=ScriptedAligner("", []))

    def test_an_undecodable_vocals_file(self, tmp_path):
        bad = tmp_path / "bad.wav"
        bad.write_bytes(b"this is not audio")
        with pytest.raises(lyrics.LyricsError, match="read"):
            lyrics.align_lyrics(str(bad), TEXT, aligner=ScriptedAligner(TEXT, STARTS))

    def test_a_silent_recording_cannot_be_aligned(self, tmp_path):
        silent = write_wav(tmp_path / "silent.wav", np.zeros(16000 * 3, dtype=np.float32), 16000)
        with pytest.raises(lyrics.LyricsError, match="silent|no singing"):
            lyrics.align_lyrics(silent, TEXT, aligner=ScriptedAligner(TEXT, STARTS))
