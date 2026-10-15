import numpy as np
import pytest

import tab_chords as tc


def vlq(n: int) -> bytes:
    out = [n & 0x7F]
    n >>= 7
    while n:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    return bytes(reversed(out))


def midi_bytes(tracks: list, division: int = 480) -> bytes:
    """tracks: lists of (tick, raw event bytes)."""
    chunks = []
    for events in tracks:
        body, last = b"", 0
        for tick, raw in sorted(events, key=lambda e: e[0]):
            body += vlq(tick - last) + raw
            last = tick
        body += vlq(0) + b"\xff\x2f\x00"
        chunks.append(b"MTrk" + len(body).to_bytes(4, "big") + body)
    header = b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big") + len(tracks).to_bytes(2, "big") + division.to_bytes(2, "big")
    return header + b"".join(chunks)


def meta(kind: int, payload: bytes) -> bytes:
    return b"\xff" + bytes([kind]) + vlq(len(payload)) + payload


def tempo(bpm: float) -> bytes:
    return meta(0x51, int(60_000_000 / bpm).to_bytes(3, "big"))


def signature(num: int, den: int) -> bytes:
    return meta(0x58, bytes([num, {2: 1, 4: 2, 8: 3}[den], 24, 8]))


def note(channel: int, pitch: int, start: int, length: int) -> list:
    return [(start, bytes([0x90 | channel, pitch, 80])), (start + length, bytes([0x80 | channel, pitch, 0]))]


def program(channel: int, value: int) -> tuple:
    return (0, bytes([0xC0 | channel, value]))


class TestReadMidi:
    def test_reads_tempo_signature_names_programs_and_notes(self, tmp_path):
        guitar = [program(0, 25), (0, meta(0x03, b"Lead"))] + note(0, 64, 0, 480) + note(0, 67, 480, 480)
        conductor = [(0, tempo(90)), (0, signature(3, 4))]
        path = tmp_path / "a.mid"
        path.write_bytes(midi_bytes([conductor, guitar]))

        m = tc.read_midi(path)
        assert m["division"] == 480
        assert m["tempos"] == [[0, pytest.approx(90.0, abs=0.01)]]
        assert m["time_signatures"] == [[0, 3, 4]]
        assert m["tracks"][1]["name"] == "Lead"
        assert m["tracks"][1]["channels"] == {0: 25}
        assert m["tracks"][1]["notes"] == [(0, 480, 64, 0), (480, 480, 67, 0)]

    def test_a_note_on_with_velocity_zero_ends_the_note(self, tmp_path):
        events = [(0, bytes([0x90, 60, 80])), (240, bytes([0x90, 60, 0]))]
        path = tmp_path / "a.mid"
        path.write_bytes(midi_bytes([events]))
        assert tc.read_midi(path)["tracks"][0]["notes"] == [(0, 240, 60, 0)]

    def test_running_status_is_understood(self, tmp_path):
        body = vlq(0) + bytes([0x90, 60, 80]) + vlq(120) + bytes([60, 0]) + vlq(0) + b"\xff\x2f\x00"
        data = (b"MThd" + (6).to_bytes(4, "big") + (0).to_bytes(2, "big") + (1).to_bytes(2, "big") + (480).to_bytes(2, "big")
                + b"MTrk" + len(body).to_bytes(4, "big") + body)
        path = tmp_path / "a.mid"
        path.write_bytes(data)
        assert tc.read_midi(path)["tracks"][0]["notes"] == [(0, 120, 60, 0)]

    def test_a_file_that_is_not_midi_is_an_error(self, tmp_path):
        path = tmp_path / "a.mid"
        path.write_bytes(b"RIFF....")
        with pytest.raises(tc.MidiError):
            tc.read_midi(path)


class TestScore:
    def make(self, tmp_path, signatures, notes_end):
        conductor = [(0, tempo(120))] + [(t, signature(n, d)) for t, n, d in signatures]
        guitar = [program(0, 25)] + note(0, 60, 0, notes_end)
        path = tmp_path / "s.mid"
        path.write_bytes(midi_bytes([conductor, guitar]))
        return tc.read_midi(path)

    def test_bars_follow_the_time_signatures(self, tmp_path):
        # 2 bars of 4/4 (1920 ticks), then 3/4 bars (1440 each)
        m = self.make(tmp_path, [(0, 4, 4), (1920, 3, 4)], 1920 + 1440 * 2)
        bars = tc.bars_from_signatures(m)
        assert [(b["tick"], b["end"]) for b in bars] == [(0, 1920), (1920, 3360), (3360, 4800)]

    def test_the_music_ends_at_its_last_note_not_at_the_end_of_track_marker(self, tmp_path):
        m = self.make(tmp_path, [(0, 4, 4)], 1920)
        assert m["end"] == 1920
        assert len(tc.bars_from_signatures(m)) == 1

    def test_roles_follow_the_general_midi_program_and_leave_vocals_and_ensembles_out(self):
        assert tc.track_role(25, False, "Guitar") == "g"
        assert tc.track_role(33, False, "Bass") == "b"
        assert tc.track_role(0, False, "Piano") == "k"
        assert tc.track_role(0, True, "Drums") == "d"
        assert tc.track_role(25, False, "Lead Vocals") is None
        assert tc.track_role(71, False, "Clarinet") is None

    def test_score_has_what_the_aligner_validates(self, tmp_path):
        m = self.make(tmp_path, [(0, 4, 4)], 3840)
        score = tc.score_from_midi(m)
        import tab_sync
        tab_sync.validate_score(score)
        assert score["notes"] == [[0, 3840, 60, "g"]]


class TestNaming:
    def weights(self, *pcs):
        w = np.zeros(12)
        for pc in pcs:
            w[pc] = 1.0
        return w

    def test_names_triads(self):
        assert tc.window_label(self.weights(0, 4, 7), None)[0] == "C:maj"
        assert tc.window_label(self.weights(9, 0, 4), None)[0] == "A:min"

    def test_the_bass_note_breaks_a_tie_between_a_chord_and_its_relative(self):
        # C E G A: C6 or A minor 7; the bass says which
        assert tc.window_label(self.weights(0, 4, 7, 9), 9)[0] == "A:min7"

    def test_a_seventh_needs_its_note_to_carry_weight(self):
        w = self.weights(0, 4, 7)
        w[10] = 0.02
        assert tc.window_label(w, None)[0] == "C:maj"
        w[10] = 1.0
        assert tc.window_label(w, None)[0] == "C:7"

    def test_a_bare_fifth_is_a_power_chord(self):
        assert tc.window_label(self.weights(4, 11), None)[0] == "E:5"

    def test_a_lone_note_is_unknown_not_a_chord(self):
        assert tc.window_label(self.weights(7), None)[0] == "X"

    def test_silence_is_no_chord(self):
        assert tc.window_label(np.zeros(12), None)[0] == "N"

    def test_notes_that_fit_nothing_are_unknown(self):
        assert tc.window_label(self.weights(0, 1, 6), None)[0] == "X"


class TestChordsFromScore:
    def score(self):
        div = 480
        bars = [{"tick": i * 4 * div, "end": (i + 1) * 4 * div, "index": i, "occurrence": 0} for i in range(3)]
        notes = []
        for bar, tones in zip(range(3), ([60, 64, 67], [67, 71, 74], [57, 60, 64])):
            for p in tones:
                notes.append([bar * 4 * div, 4 * div, p, "g"])
        return {"version": 1, "division": div, "tempos": [[0, 120]], "bars": bars, "notes": notes}

    def test_names_each_bar_and_places_it_by_the_bar_times(self):
        segs = tc.chords_from_score(self.score(), [1.0, 3.0, 5.0])
        assert [(s["chord"], s["start"], s["end"]) for s in segs] == [
            ("C:maj", 1.0, 3.0), ("G:maj", 3.0, 5.0), ("A:min", 5.0, 7.0)]

    def test_the_aligners_retune_moves_the_names_into_the_recordings_key(self):
        segs = tc.chords_from_score(self.score(), [0.0, 2.0, 4.0], shift=2)
        assert [s["chord"] for s in segs] == ["D:maj", "A:maj", "B:min"]

    def test_neighbouring_beats_with_the_same_chord_are_one_segment(self):
        segs = tc.chords_from_score(self.score(), [0.0, 2.0, 4.0])
        assert len(segs) == 3
        assert all(a["end"] == b["start"] for a, b in zip(segs, segs[1:]))

    def test_the_chart_is_written_in_the_form_the_harness_reads(self, tmp_path):
        import chord_eval
        segs = tc.chords_from_score(self.score(), [0.0, 2.0, 4.0])
        path = tmp_path / "t.lab"
        tc.write_lab(segs, path)
        read = chord_eval.read_lab(path)
        assert [s["chord"] for s in read] == ["C:maj", "G:maj", "A:min"]
        assert read[0]["start"] == 0.0 and read[-1]["end"] == pytest.approx(6.0)
