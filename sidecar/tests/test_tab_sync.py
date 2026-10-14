"""Tab sync: tab bar lines placed on a recording, on synthetic tabs and stems with a known timeline."""

import json

import numpy as np
import pytest

import tab_sync
from helpers import write_wav

SR = tab_sync.SAMPLE_RATE
DIV = 480
BPM = 100.0
BAR_TICKS = DIV * 4
BAR_SECONDS = 60.0 / BPM * 4

CHORDS = {
    "C": [48, 52, 55, 60], "Am": [45, 52, 57, 60], "F": [41, 53, 57, 60], "G": [43, 50, 55, 59],
    "Em": [40, 52, 55, 59], "Dm": [38, 50, 57, 62], "Bb": [46, 53, 58, 62], "A": [45, 52, 57, 61],
}
PROGRESSION = ["C", "Am", "F", "G", "Em", "Dm", "Bb", "A"]
ARPEGGIO = [0, 1, 2, 3, 2, 1, 2, 1]


def make_score(n_bars=16, drums=True):
    notes = []
    for bar in range(n_bars):
        chord = CHORDS[PROGRESSION[bar % len(PROGRESSION)]]
        base = bar * BAR_TICKS
        for i, k in enumerate(ARPEGGIO):
            notes.append([base + i * DIV // 2, DIV // 2, chord[k], "g"])
        notes.append([base, BAR_TICKS, chord[0] - 12, "b"])
        if drums:
            for beat in range(4):
                notes.append([base + beat * DIV, DIV // 4, 36 if beat % 2 == 0 else 38, "d"])
    bars = [{"tick": b * BAR_TICKS, "end": (b + 1) * BAR_TICKS, "index": b, "occurrence": 0} for b in range(n_bars)]
    return {"version": 1, "division": DIV, "tempos": [[0, BPM]], "bars": bars, "notes": notes}


def nominal_seconds(ticks):
    return np.asarray(ticks, dtype=np.float64) / DIV * 60.0 / BPM


def rubato(nominal, lead):
    """True recording time of a nominal time: +-13 % tempo drift and a lead-in."""
    return lead + nominal + 0.8 * (1 - np.cos(np.asarray(nominal) / 6.0))


def render(score, tmp_path, lead=1.7, transpose=0, noise_seed=None):
    n_bars = len(score["bars"])
    total = float(rubato(nominal_seconds(n_bars * BAR_TICKS), lead)) + 2.0
    out = {r: np.zeros(int(total * SR), np.float32) for r in ("guitar", "bass", "drums")}
    rng = np.random.default_rng(0)
    for tick, dur, pitch, role in score["notes"]:
        t0 = float(rubato(nominal_seconds(tick), lead))
        t1 = float(rubato(nominal_seconds(tick + dur), lead))
        n = max(int((t1 - t0) * SR), 64)
        t = np.arange(n) / SR
        if role == "d":
            if pitch == 36:
                x = np.sin(2 * np.pi * (110 * np.exp(-t * 25) + 45) * t) * np.exp(-t * 30)
            else:
                x = rng.standard_normal(n) * np.exp(-t * 40) * 0.6
            stem = "drums"
        else:
            f = 440.0 * 2 ** ((pitch + transpose - 69) / 12)
            x = sum(np.sin(2 * np.pi * f * k * t) / k for k in (1, 2, 3)) * np.exp(-t * 3)
            stem = "guitar" if role == "g" else "bass"
        s = int(t0 * SR)
        n = min(n, len(out[stem]) - s)
        out[stem][s:s + n] += (0.3 * x[:n]).astype(np.float32)
    paths = {}
    for name, audio in out.items():
        if noise_seed is not None and name != "drums":
            audio = (np.random.default_rng(noise_seed).standard_normal(len(audio)) * 0.2).astype(np.float32)
        paths[name] = write_wav(tmp_path / f"{name}.wav", audio, SR)
    truth = rubato(nominal_seconds([b["tick"] for b in score["bars"]]), lead)
    return paths, truth


def errors(result, truth):
    est = np.array([b["time"] for b in result["bars"]])
    return np.abs(est - truth)


class TestValidation:
    def test_a_good_score_passes(self):
        tab_sync.validate_score(make_score(2))

    @pytest.mark.parametrize("mutate, message", [
        (lambda s: s.update(version=2), "Unsupported"),
        (lambda s: s.update(division=0), "time resolution"),
        (lambda s: s.update(tempos=[]), "tempo"),
        (lambda s: s.update(tempos=[[0, 0]]), "tempo"),
        (lambda s: s.update(bars=[]), "no bars"),
        (lambda s: s["bars"].append({"tick": 5, "end": 5, "index": 9, "occurrence": 0}), "malformed"),
        (lambda s: s.update(notes=[[0, 10, 36, "d"]]), "no guitar, bass or keyboard"),
        (lambda s: s.update(notes=None), "no notes"),
    ])
    def test_a_bad_score_is_refused_with_a_message(self, mutate, message):
        score = make_score(2)
        mutate(score)
        with pytest.raises(tab_sync.TabSyncError, match=message):
            tab_sync.validate_score(score)

    def test_a_non_dict_is_refused(self):
        with pytest.raises(tab_sync.TabSyncError):
            tab_sync.validate_score([1, 2])


class TestTimeline:
    def test_constant_tempo(self):
        to_sec = tab_sync._tick_seconds({"division": 480, "tempos": [[0, 120]]})
        assert to_sec([480, 960])[1] == pytest.approx(1.0)

    def test_tempo_change_applies_from_its_tick(self):
        to_sec = tab_sync._tick_seconds({"division": 480, "tempos": [[0, 120], [960, 60]]})
        assert to_sec([960])[0] == pytest.approx(1.0)
        assert to_sec([1440])[0] == pytest.approx(2.0)

    def test_a_tempo_map_that_starts_late_is_extended_back_to_zero(self):
        to_sec = tab_sync._tick_seconds({"division": 480, "tempos": [[480, 120]]})
        assert to_sec([480])[0] == pytest.approx(0.5)


class TestFeatures:
    def test_pitch_classes_and_drum_hits_land_on_the_right_frames(self):
        score = {"version": 1, "division": 480, "tempos": [[0, 120]], "bars": [],
                 "notes": [[0, 480, 60, "g"], [480, 480, 67, "b"], [960, 10, 36, "d"], [1440, 10, 38, "d"]]}
        chroma, kick, snare = tab_sync.score_features(score, int(3 * tab_sync.FPS))
        assert chroma[0, int(0.25 * tab_sync.FPS)] > 0 and chroma[7, int(0.75 * tab_sync.FPS)] > 0
        assert chroma[7, int(0.25 * tab_sync.FPS)] == 0
        assert int(np.argmax(kick)) == pytest.approx(int(1.0 * tab_sync.FPS), abs=1)
        assert int(np.argmax(snare)) == pytest.approx(int(1.5 * tab_sync.FPS), abs=1)

    def test_a_note_past_the_end_is_ignored(self):
        score = {"version": 1, "division": 480, "tempos": [[0, 120]], "bars": [], "notes": [[48000, 480, 60, "g"]]}
        chroma, _, _ = tab_sync.score_features(score, 10)
        assert chroma.sum() == 0


class TestOffset:
    def test_a_known_shift_is_found(self):
        rng = np.random.default_rng(1)
        S = tab_sync._normalize(rng.random((14, 400)))
        shift = 57
        A = np.concatenate([tab_sync._normalize(rng.random((14, shift))), S, tab_sync._normalize(rng.random((14, 200)))], axis=1)
        lag, peak, base = tab_sync.best_offset(S, A)
        assert lag == shift and peak > base + 0.2

    def test_a_tab_that_starts_before_the_recording_gives_a_negative_lag(self):
        rng = np.random.default_rng(2)
        full = tab_sync._normalize(rng.random((14, 500)))
        lag, _, _ = tab_sync.best_offset(full, full[:, 30:])
        assert lag == -30


class TestBandedDtw:
    def test_identical_features_follow_the_diagonal(self):
        rng = np.random.default_rng(3)
        S = tab_sync._normalize(rng.random((14, 300)))
        j, cost = tab_sync.banded_dtw(S, S.copy(), 0, 40)
        assert np.allclose(j, np.arange(300), atol=0.5) and cost < 0.05

    def test_a_tempo_ramp_is_recovered(self):
        rng = np.random.default_rng(4)
        S = tab_sync._normalize(rng.random((14, 600)))
        score_i = np.arange(600)
        warp = score_i + 20 * np.sin(score_i / 50.0)
        source = np.interp(np.arange(600), warp, score_i)
        A = S[:, np.clip(np.round(source).astype(int), 0, 599)]
        j, _ = tab_sync.banded_dtw(S, A, 0, 60)
        assert np.median(np.abs(j - warp)) < 3 and np.max(np.abs(j - warp)) < 12

    def test_the_path_never_leaves_the_band(self):
        rng = np.random.default_rng(5)
        S = tab_sync._normalize(rng.random((14, 200)))
        A = tab_sync._normalize(rng.random((14, 200)))
        j, _ = tab_sync.banded_dtw(S, A, 10, 20)
        assert np.all(np.abs(j - (np.arange(200) + 10)) <= 20 + 1e-6)


class TestAlignment:
    def test_bar_lines_follow_a_drifting_recording(self, tmp_path):
        score = make_score()
        paths, truth = render(score, tmp_path)
        result = tab_sync.align_tab_to_stems(score, paths)
        err = errors(result, truth)
        assert np.median(err) < 0.08 and err.max() < 0.2, np.round(err, 2)
        assert result["transpose"] == 0 and result["usedDrums"] is True
        assert result["quality"] == "good" and result["offset"] == pytest.approx(1.7, abs=0.5)

    def test_works_without_a_drum_stem(self, tmp_path):
        score = make_score()
        paths, truth = render(score, tmp_path)
        del paths["drums"]
        result = tab_sync.align_tab_to_stems(score, paths)
        assert errors(result, truth).max() < 0.25 and result["usedDrums"] is False

    def test_a_tab_a_semitone_below_the_recording_is_transposed(self, tmp_path):
        score = make_score()
        paths, truth = render(score, tmp_path, transpose=1)
        result = tab_sync.align_tab_to_stems(score, paths)
        assert result["transpose"] == 1
        assert errors(result, truth).max() < 0.25

    def test_bar_times_never_decrease(self, tmp_path):
        score = make_score()
        paths, _ = render(score, tmp_path)
        times = [b["time"] for b in tab_sync.align_tab_to_stems(score, paths)["bars"]]
        assert times == sorted(times)

    def test_each_played_bar_keeps_its_index_and_occurrence(self, tmp_path):
        score = make_score(8)
        score["bars"][4]["occurrence"] = 1
        paths, _ = render(score, tmp_path)
        bars = tab_sync.align_tab_to_stems(score, paths)["bars"]
        assert [(b["index"], b["occurrence"]) for b in bars][3:6] == [(3, 0), (4, 1), (5, 0)]

    def test_unrelated_audio_is_not_trusted(self, tmp_path):
        score = make_score()
        paths, _ = render(score, tmp_path, noise_seed=9)
        result = tab_sync.align_tab_to_stems(score, paths)
        assert result["quality"] == "poor" and result["meanCost"] > tab_sync.CHECK_COST

    def test_progress_runs_forward_to_one(self, tmp_path):
        score = make_score(6)
        paths, _ = render(score, tmp_path)
        seen = []
        tab_sync.align_tab_to_stems(score, paths, lambda v, s: seen.append((v, s)))
        assert [v for v, _ in seen] == sorted(v for v, _ in seen) and seen[-1][0] == 1.0

    def test_a_song_with_no_harmony_stem_is_refused(self, tmp_path):
        score = make_score(4)
        paths, _ = render(score, tmp_path)
        with pytest.raises(tab_sync.TabSyncError, match="no guitar, bass, piano or other stem"):
            tab_sync.align_tab_to_stems(score, {"drums": paths["drums"], "vocals": str(tmp_path / "nope.wav")})

    def test_silent_stems_are_refused(self, tmp_path):
        score = make_score(4)
        silent = write_wav(tmp_path / "other.wav", np.zeros(SR * 5, np.float32), SR)
        with pytest.raises(tab_sync.TabSyncError, match="silent"):
            tab_sync.align_tab_to_stems(score, {"other": silent})

    def test_a_tab_with_notes_outside_its_bars_only_is_refused(self, tmp_path):
        score = make_score(4)
        score["notes"] = [[10 ** 7, 480, 60, "g"]]
        paths = {"other": write_wav(tmp_path / "other.wav", np.ones(SR, np.float32) * 0.1, SR)}
        with pytest.raises(tab_sync.TabSyncError, match="no notes inside"):
            tab_sync.align_tab_to_stems(score, paths)


class TestFile:
    def test_the_result_file_is_written_whole(self, tmp_path):
        score = make_score(8)
        paths, truth = render(score, tmp_path)
        score_path = tmp_path / "score.json"
        score_path.write_text(json.dumps(score), encoding="utf-8")
        out = tmp_path / "tab_sync.json"
        summary = tab_sync.align_tab_file(str(score_path), paths, str(out))
        data = json.loads(out.read_text(encoding="utf-8"))
        assert data["algorithm"] == tab_sync.ALGORITHM and len(data["bars"]) == 8
        assert summary["bars"] == 8 and summary["quality"] == data["quality"]
        assert not (tmp_path / "tab_sync.json.tmp").exists()
        assert errors(data, truth[:8]).max() < 0.25
