"""meter.py: finding a song's bars from its stems, on audio whose bars are known."""

import json

import numpy as np
import pytest

import meter
from helpers import write_wav

SR = 22050


def drum_hit(seconds: float, low: bool, amp: float) -> np.ndarray:
    """A short burst: a falling sine for a kick, noise for anything else."""
    n = int(SR * seconds)
    t = np.arange(n) / SR
    env = np.exp(-t * 40)
    if low:
        return (amp * np.sin(2 * np.pi * (110 - 60 * t / seconds) * t) * env).astype(np.float32)
    rng = np.random.default_rng(1)
    return (amp * (rng.random(n) * 2 - 1) * env).astype(np.float32)


def make_stems(tmp_path, per_bar: int, bars: int = 24, period: float = 0.5, lead_beats: int = 0):
    """Drums and bass at a steady beat; the first beat of every bar is a kick and a bass note, the rest a hat."""
    total = (lead_beats + per_bar * bars) * period + 1.0
    drums = np.zeros(int(SR * total), dtype=np.float32)
    bass = np.zeros_like(drums)
    other = np.zeros_like(drums)
    for k in range(lead_beats + per_bar * bars):
        at = int(SR * (0.3 + k * period))
        first = k >= lead_beats and (k - lead_beats) % per_bar == 0
        hit = drum_hit(0.1, low=first, amp=0.9 if first else 0.25)
        drums[at:at + len(hit)] += hit[: len(drums) - at]
        if first:
            note = (0.5 * np.sin(2 * np.pi * 55 * np.arange(int(SR * 0.25)) / SR)).astype(np.float32)
            bass[at:at + len(note)] += note[: len(bass) - at]
            tone = (0.3 * np.sin(2 * np.pi * 220 * np.arange(int(SR * 0.4)) / SR)).astype(np.float32)
            other[at:at + len(tone)] += tone[: len(other) - at]
    return {
        "drums": write_wav(tmp_path / "drums.wav", drums, SR),
        "bass": write_wav(tmp_path / "bass.wav", bass, SR),
        "other": write_wav(tmp_path / "other.wav", other, SR),
    }


class TestAccents:
    def test_a_position_that_stands_out_explains_the_variation(self):
        values = np.tile([5.0, 1.0, 1.0, 1.0], 20) + np.random.default_rng(0).normal(0, 0.1, 80)
        assert meter._adjusted_r2(values, 4) > 0.9
        assert meter._adjusted_r2(values, 3) < 0.2

    def test_a_flat_feature_explains_nothing(self):
        values = np.random.default_rng(0).normal(0, 1, 200)
        assert abs(meter._adjusted_r2(values, 4)) < 0.1


class TestChoosingTheLength:
    def test_prefers_the_shorter_length_that_explains_nearly_as_much(self):
        assert meter.choose_bar_length({2: 0.0, 3: 0.66, 4: 0.0, 5: 0.0, 6: 0.68, 7: 0.0}) == 3
        assert meter.choose_bar_length({2: 0.3, 3: 0.0, 4: 0.5, 5: 0.0, 6: 0.0, 7: 0.0}) == 4

    def test_keeps_the_longer_one_when_the_shorter_explains_much_less(self):
        assert meter.choose_bar_length({2: 0.1, 3: 0.0, 4: 0.6, 5: 0.0, 6: 0.0, 7: 0.0}) == 4

    def test_a_length_that_is_no_divisor_never_replaces_the_best(self):
        assert meter.choose_bar_length({2: 0.0, 3: 0.6, 4: 0.0, 5: 0.7, 6: 0.0, 7: 0.0}) == 5


class TestBarsFromBeats:
    times = np.arange(0, 20, 0.5)

    def test_cuts_the_beats_into_whole_bars_from_the_phase(self):
        cut = meter.bars_from_beats(self.times, 4, 1, 4, end=40)
        assert [b["start"] for b in cut["bars"]][:3] == [0.5, 2.5, 4.5]
        assert all(b["num"] == 4 and b["den"] == 4 for b in cut["bars"])

    def test_the_map_ends_where_the_last_whole_bar_does(self):
        cut = meter.bars_from_beats(np.arange(0, 8.5, 0.5), 4, 0, 4, end=99)
        assert [b["start"] for b in cut["bars"]] == [0.0, 2.0, 4.0, 6.0]
        assert cut["end"] == pytest.approx(8.0)

    def test_the_end_never_passes_the_song(self):
        cut = meter.bars_from_beats(np.arange(0, 8.5, 0.5), 4, 0, 4, end=7.2)
        assert cut["end"] == pytest.approx(7.2)

    def test_too_few_beats_make_no_bars(self):
        assert meter.bars_from_beats(np.arange(0, 1.5, 0.5), 4, 0, 4, end=5)["bars"] == []


class TestConfidence:
    def test_is_high_when_one_length_leads_clearly_and_low_when_nothing_stands_out(self):
        clear = {2: 0.01, 3: 0.0, 4: 0.15, 5: 0.0, 6: 0.01, 7: 0.0}
        flat = {2: 0.01, 3: 0.0, 4: 0.011, 5: 0.0, 6: 0.01, 7: 0.0}
        assert meter.confidence_of(clear, 4) == 1.0
        assert meter.confidence_of(flat, 4) < 0.05

    def test_does_not_count_the_same_answer_in_another_size_as_a_rival(self):
        doubled = {2: 0.0, 3: 0.67, 4: 0.0, 5: 0.0, 6: 0.66, 7: 0.0}
        assert meter.confidence_of(doubled, 3) == 1.0


@pytest.mark.parametrize("per_bar", [3, 4, 5, 7])
def test_finds_the_bar_length_of_a_steady_pattern(tmp_path, per_bar):
    doc = meter.detect_meter(make_stems(tmp_path, per_bar))
    assert doc is not None
    assert {b["num"] for b in doc["bars"]} == {per_bar}
    assert doc["source"] == "detected"
    assert doc["confidence"] > 0.5


def test_the_first_bar_starts_on_the_kick_not_on_the_first_beat_heard(tmp_path):
    doc = meter.detect_meter(make_stems(tmp_path, 4, lead_beats=2))
    first = doc["bars"][0]["start"]
    assert first == pytest.approx(0.3 + 2 * 0.5, abs=0.06) or first == pytest.approx(0.3 + 6 * 0.5, abs=0.06) or first >= 1.2
    starts = np.array([b["start"] for b in doc["bars"]])
    kicks = 0.3 + (2 + 4 * np.arange(10)) * 0.5
    assert min(abs(starts[:, None] - kicks[None, :]).min(axis=1)) < 0.06


def test_counts_a_quick_beat_in_eighths_and_a_slow_one_in_quarters():
    assert meter.unit_for_period(0.28) == 8
    assert meter.unit_for_period(0.5) == 4


def test_a_song_without_a_beat_has_no_bars(tmp_path):
    silence = write_wav(tmp_path / "drums.wav", np.zeros(SR * 30, dtype=np.float32), SR)
    assert meter.detect_meter({"drums": silence}) is None


def test_writes_meter_json_for_the_app(tmp_path):
    stems = make_stems(tmp_path, 5)
    out = tmp_path / "meter.json"
    summary = meter.detect_meter_from_stems(stems, str(out))
    doc = json.loads(out.read_text(encoding="utf-8"))
    assert summary["perBar"] == 5
    assert doc["version"] == 1 and doc["algorithm"] == meter.ALGORITHM
    assert doc["end"] > doc["bars"][-1]["start"]
    assert all(set(b) == {"start", "num", "den"} for b in doc["bars"])


def test_says_so_when_there_is_nothing_to_write(tmp_path):
    silence = write_wav(tmp_path / "drums.wav", np.zeros(SR * 30, dtype=np.float32), SR)
    out = tmp_path / "meter.json"
    out.write_text("{}", encoding="utf-8")
    with pytest.raises(ValueError, match="steady beat"):
        meter.detect_meter_from_stems({"drums": silence}, str(out))
    assert not out.exists(), "an old result must not outlive a failed search"
