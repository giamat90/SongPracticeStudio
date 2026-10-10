"""CTC forced alignment: the Viterbi that pins each lyric letter to a frame."""

import numpy as np
import pytest

import lyrics

BLANK = 0
N_CLASSES = 6


def emissions(path, n_classes=N_CLASSES, peak=0.9):
    """Log-probabilities for a hand-written frame labelling (blank = 0)."""
    rest = (1.0 - peak) / (n_classes - 1)
    probs = np.full((len(path), n_classes), rest)
    for t, label in enumerate(path):
        probs[t, label] = peak
    return np.log(probs)


class TestForcedAlign:
    def test_finds_the_frame_each_token_is_emitted_on(self):
        path = [0, 0, 1, 0, 0, 2, 0, 0, 3, 0]
        spans = lyrics.ctc_forced_align(emissions(path), [1, 2, 3])
        assert [(s.start, s.end) for s in spans] == [(2, 3), (5, 6), (8, 9)]

    def test_a_token_held_over_several_frames_is_one_span(self):
        path = [0, 1, 1, 1, 0, 2, 2, 0]
        spans = lyrics.ctc_forced_align(emissions(path), [1, 2])
        assert [(s.start, s.end) for s in spans] == [(1, 4), (5, 7)]

    def test_a_repeated_letter_needs_a_gap_and_is_still_two_tokens(self):
        path = [0, 1, 0, 1, 0]
        spans = lyrics.ctc_forced_align(emissions(path), [1, 1])
        assert [(s.start, s.end) for s in spans] == [(1, 2), (3, 4)]

    def test_adjacent_different_letters_need_no_gap(self):
        path = [1, 2, 3]
        spans = lyrics.ctc_forced_align(emissions(path), [1, 2, 3])
        assert [(s.start, s.end) for s in spans] == [(0, 1), (1, 2), (2, 3)]

    def test_spans_are_ordered_and_never_overlap(self):
        rng = np.random.default_rng(3)
        logits = rng.normal(size=(120, N_CLASSES))
        log_probs = logits - np.logaddexp.reduce(logits, axis=1, keepdims=True)
        targets = [int(x) for x in rng.integers(1, N_CLASSES, size=30)]
        spans = lyrics.ctc_forced_align(log_probs, targets)
        assert len(spans) == len(targets)
        for a, b in zip(spans, spans[1:]):
            assert a.start < a.end <= b.start < b.end

    def test_score_is_the_mean_probability_over_the_span(self):
        path = [0, 1, 1, 0]
        spans = lyrics.ctc_forced_align(emissions(path, peak=0.8), [1])
        assert spans[0].score == pytest.approx(0.8)

    def test_silence_before_and_after_does_not_stretch_a_token(self):
        path = [0] * 40 + [1, 1] + [0] * 40
        spans = lyrics.ctc_forced_align(emissions(path), [1])
        assert (spans[0].start, spans[0].end) == (40, 42)

    def test_no_targets_means_no_spans(self):
        assert lyrics.ctc_forced_align(emissions([0, 0, 0]), []) == []

    def test_audio_too_short_for_the_text_is_reported_not_garbled(self):
        with pytest.raises(lyrics.LyricsError, match="too long"):
            lyrics.ctc_forced_align(emissions([0, 1, 2]), [1, 2, 3, 4])

    def test_a_repeat_needs_one_more_frame_than_the_letters_alone(self):
        assert len(lyrics.ctc_forced_align(emissions([1, 2]), [1, 2])) == 2
        with pytest.raises(lyrics.LyricsError, match="too long"):
            lyrics.ctc_forced_align(emissions([1, 1]), [1, 1])

    def test_a_lattice_too_large_to_hold_in_memory_is_refused_up_front(self, monkeypatch):
        monkeypatch.setattr(lyrics, "MAX_LATTICE_CELLS", 100)
        with pytest.raises(lyrics.LyricsError, match="too long to align"):
            lyrics.ctc_forced_align(emissions([0] * 40 + [1, 2, 3]), [1, 2, 3])

    def test_a_non_zero_blank_index(self):
        n = 4
        probs = np.full((5, n), 0.05)
        for t, k in enumerate([3, 1, 3, 2, 3]):
            probs[t, k] = 0.85
        spans = lyrics.ctc_forced_align(np.log(probs), [1, 2], blank=3)
        assert [(s.start, s.end) for s in spans] == [(1, 2), (3, 4)]


class TestAgainstTorchaudio:
    """The numpy Viterbi is a drop-in for torchaudio's: same path, no torch needed."""

    def test_matches_torchaudio_forced_align_on_random_emissions(self):
        torch = pytest.importorskip("torch")
        torchaudio = pytest.importorskip("torchaudio")
        functional = torchaudio.functional
        if not hasattr(functional, "forced_align"):
            pytest.skip("this torchaudio has no forced_align")

        rng = np.random.default_rng(11)
        for trial in range(5):
            T = int(rng.integers(150, 400))
            targets = [int(x) for x in rng.integers(1, 12, size=int(rng.integers(10, 60)))]
            logits = rng.normal(size=(T, 12)).astype("float32")
            log_probs = logits - np.logaddexp.reduce(logits, axis=1, keepdims=True)

            ours = lyrics.ctc_forced_align(log_probs, targets)

            ali, _ = functional.forced_align(
                torch.from_numpy(log_probs)[None], torch.tensor([targets], dtype=torch.int32), blank=0
            )
            theirs = functional.merge_tokens(ali[0], torch.ones(T))
            assert [(s.start, s.end) for s in ours] == [(s.start, s.end) for s in theirs], f"trial {trial}"
