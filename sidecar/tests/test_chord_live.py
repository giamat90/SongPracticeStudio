"""The chord lab's real-time engine and tool (chord_lab/realtime.py, chord_lab/live.py): no audio hardware needed."""

import sys
import types
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

LAB_DIR = Path(__file__).resolve().parent.parent / "chord_lab"
if str(LAB_DIR) not in sys.path:
    sys.path.insert(0, str(LAB_DIR))

import live  # noqa: E402
import realtime as rt  # noqa: E402

SR = 44100

SHAPES = {
    "C:maj": [130.81, 164.81, 196.00, 261.63, 329.63],
    "G:maj": [98.00, 123.47, 146.83, 196.00, 246.94, 392.00],
    "A:min": [110.00, 164.81, 220.00, 261.63, 329.63],
    "E:min": [82.41, 123.47, 164.81, 196.00, 246.94, 329.63],
    "D:maj": [146.83, 220.00, 293.66, 369.99],
    "E:maj": [82.41, 123.47, 164.81, 207.65, 246.94, 329.63],
}


def note(freq, seconds, amp=0.3, decay=1.2, sr=SR):
    """A plucked-string-like tone: harmonics that fade, the upper ones faster."""
    t = np.arange(int(seconds * sr)) / sr
    out = np.zeros_like(t)
    for k in range(1, 9):
        out += (1.0 / k ** 1.1) * np.exp(-t * (decay + 0.5 * k)) * np.sin(2 * np.pi * k * freq * t + k)
    return (amp * out).astype(np.float32)


def strum(freqs, seconds=2.0, spread=0.012, cents=0.0, sr=SR):
    out = np.zeros(int(seconds * sr), dtype=np.float32)
    for i, f in enumerate(freqs):
        n = note(f * 2 ** (cents / 1200), seconds - i * spread, sr=sr)
        start = int(i * spread * sr)
        out[start:start + len(n)] += n
    return out


def run(audio, settings=None, block=512, sr=SR):
    engine = rt.LiveAnalyzer(sr, settings)
    frames = []
    for i in range(0, len(audio), block):
        frames += engine.feed(audio[i:i + block])
    return frames


PROGRESSION = ["C:maj", "G:maj", "A:min", "E:min", "D:maj", "E:maj"]


class TestYin:
    @pytest.mark.parametrize("freq", [82.41, 110.0, 196.0, 329.63, 440.0, 880.0])
    def test_finds_the_pitch_of_one_note_within_a_few_cents(self, freq):
        x = note(freq, 0.2, decay=0.2)[:2048]
        f0, clarity = rt.yin(x, SR)
        assert 1200 * np.log2(f0 / freq) == pytest.approx(0, abs=4)
        assert clarity > 0.9

    def test_a_weak_fundamental_is_still_the_fundamental(self):
        t = np.arange(2048) / SR
        x = 0.3 * np.sin(2 * np.pi * 110 * t) + 0.5 * np.sin(2 * np.pi * 220 * t) + 0.5 * np.sin(2 * np.pi * 330 * t)
        assert rt.yin(x.astype(np.float32), SR)[0] == pytest.approx(110, abs=1.0)

    def test_noise_has_no_clarity(self):
        x = np.random.default_rng(0).normal(0, 0.1, 2048).astype(np.float32)
        assert rt.yin(x, SR)[1] < 0.6

    def test_a_frame_too_short_gives_nothing(self):
        assert rt.yin(np.zeros(64, dtype=np.float32), SR) is None


class TestAnalyzer:
    def song(self, cents=0.0, order=PROGRESSION):
        return np.concatenate([strum(SHAPES[c], cents=cents) for c in order])

    def test_follows_strummed_chords_and_names_them_right(self):
        frames = run(self.song())
        for k, chord in enumerate(PROGRESSION):
            late = [f for f in frames if k * 2.0 + 1.5 <= f.t < (k + 1) * 2.0]
            assert {f.chord for f in late} == {chord}, chord

    def test_a_new_chord_shows_within_about_half_a_second(self):
        frames = run(self.song())
        for k, chord in enumerate(PROGRESSION):
            first = next(f for f in frames if f.t >= k * 2.0 and f.chord == chord)
            assert first.t - k * 2.0 < 0.6, chord

    @pytest.mark.parametrize("cents", [30, -25])
    def test_a_guitar_out_of_tune_with_a440_is_followed_and_still_read_right(self, cents):
        frames = run(self.song(cents=cents))
        assert frames[-1].tuning == pytest.approx(cents, abs=6)
        late = [f for f in frames if 11.5 <= f.t < 12.0]
        assert {f.chord for f in late} == {"E:maj"}

    def test_a_fixed_tuning_is_not_followed(self):
        frames = run(self.song(cents=30), rt.Settings(tuning=0.0))
        assert {f.tuning for f in frames} == {0.0}

    def test_silence_is_quiet_and_holds_no_chord_in_the_segments(self):
        audio = np.concatenate([strum(SHAPES["C:maj"], 1.5), np.zeros(SR)])
        frames = run(audio)
        assert frames[-1].silent
        assert all(not f.silent for f in frames if f.t < 1.2)
        assert [s["chord"] for s in rt.segments(frames, 0.3, 0.05)] == ["C:maj"]

    def test_the_block_size_does_not_change_the_answer(self):
        audio = self.song(order=PROGRESSION[:3])
        a, b = run(audio, block=100), run(audio, block=8192)
        assert [(round(f.t, 4), f.chord) for f in a] == [(round(f.t, 4), f.chord) for f in b]

    def test_one_plucked_note_is_a_note_with_its_cents(self):
        audio = note(82.41 * 2 ** (12 / 1200), 2.0, decay=0.3)
        late = [f for f in run(audio) if f.t > 1.0]
        assert all(f.mono and f.pitch.name == "E2" for f in late)
        assert late[-1].pitch.cents == pytest.approx(12, abs=4)

    def test_a_strummed_chord_is_not_taken_for_one_note(self):
        frames = run(self.song(order=["D:maj", "C:maj", "E:maj"]))
        assert not any(f.mono for f in frames)

    def test_the_bass_note_under_a_chord_makes_it_a_slash_chord(self):
        audio = strum([82.41] + SHAPES["C:maj"][1:], seconds=2.5)
        late = [f for f in run(audio) if f.t > 1.5]
        assert {(f.chord, f.bass) for f in late} == {("C:maj", "E")}

    def test_works_at_other_sample_rates(self):
        audio = np.concatenate([strum(SHAPES["G:maj"], sr=48000), strum(SHAPES["A:min"], sr=48000)])
        frames = run(audio, sr=48000)
        assert {f.chord for f in frames if 3.5 <= f.t < 4.0} == {"A:min"}

    G7 = [98.00, 123.47, 146.83, 196.00, 246.94, 349.23]

    def test_a_seventh_has_to_be_clear_to_be_named_so_a_faint_one_is_the_plain_chord(self):
        late = [f for f in run(strum(self.G7, seconds=3.0)) if f.t > 2.0]
        assert {f.chord for f in late} == {"G:maj"}

    def test_a_seventh_is_named_once_the_margin_is_out_of_the_way(self):
        late = [f for f in run(strum(self.G7, seconds=3.0), rt.Settings(seventh_margin=0.0)) if f.t > 2.0]
        assert {f.chord for f in late} == {"G:7"}

    def test_every_frame_carries_alternatives_that_are_other_chords(self):
        frames = run(self.song(order=["C:maj"]))
        f = frames[-1]
        assert f.alternatives and f.chord not in [c for c, _ in f.alternatives]
        assert 0.0 <= f.fit <= 1.0


class TestSegments:
    def frame(self, t, chord, silent=False):
        return rt.Frame(t, -20.0, silent, None, False, np.zeros(12), chord, None, 1.0, chord, [], 0.0)

    def test_runs_become_segments_placed_a_delay_before_their_first_frame(self):
        frames = [self.frame(1.0, "C:maj"), self.frame(1.05, "C:maj"), self.frame(1.1, "G:maj"), self.frame(1.15, "G:maj")]
        segs = rt.segments(frames, 0.3, 0.05)
        assert [s["chord"] for s in segs] == ["C:maj", "G:maj"]
        assert segs[0]["start"] == pytest.approx(0.7) and segs[0]["end"] == pytest.approx(0.8)
        assert segs[1]["start"] == pytest.approx(0.8) and segs[1]["end"] == pytest.approx(0.9)

    def test_silence_ends_a_chord_and_nothing_starts_before_zero(self):
        frames = [self.frame(0.1, "C:maj"), self.frame(0.15, "C:maj", silent=True), self.frame(0.2, "C:maj", silent=True)]
        segs = rt.segments(frames, 0.3, 0.05)
        assert len(segs) == 1 and segs[0]["start"] == 0.0


class TestNames:
    def test_pretty(self):
        assert rt.pretty("A:min7", "C") == "Am7/C"
        assert rt.pretty("C:maj") == "C"
        assert rt.pretty("G:7") == "G7"
        assert rt.pretty(None) == "-"

    def test_a_capo_names_the_shapes_not_the_sounds(self):
        assert rt.pretty("A:maj", None, capo=2) == "G"
        assert rt.pretty("C#:min", "E", capo=4) == "Am/C"


class TestChannelPicker:
    def block(self, left, right):
        return np.stack([np.full(100, left), np.full(100, right)], axis=1).astype(np.float32)

    def test_auto_follows_the_louder_input(self):
        pick = live.ChannelPicker("auto")
        assert pick(self.block(0.001, 0.4))[0] == pytest.approx(0.4)
        pick2 = live.ChannelPicker("auto")
        assert pick2(self.block(0.4, 0.0))[0] == pytest.approx(0.4)

    def test_mix_averages_and_a_number_picks(self):
        assert live.ChannelPicker("mix")(self.block(0.2, 0.4))[0] == pytest.approx(0.3)
        assert live.ChannelPicker("1")(self.block(0.2, 0.4))[0] == pytest.approx(0.4)

    def test_a_mono_block_passes_through(self):
        assert live.ChannelPicker("auto")(np.ones((10, 1), dtype=np.float32)).shape == (10,)


class FakeSounddevice(types.ModuleType):
    """Enough of sounddevice for the tool: a device list, and a stream the test can push blocks into."""

    def __init__(self):
        super().__init__("sounddevice")
        self.default = types.SimpleNamespace(device=(1, 4))
        self.devices = [
            {"name": "Speakers", "hostapi": 0, "max_input_channels": 0, "default_samplerate": 44100.0},
            {"name": "Microphone (EarPods)", "hostapi": 0, "max_input_channels": 2, "default_samplerate": 44100.0},
            {"name": "Analogue 1 + 2 (Focusrite USB Audio)", "hostapi": 0, "max_input_channels": 2, "default_samplerate": 44100.0},
            {"name": "Analogue 1 + 2 (Focusrite USB Audio)", "hostapi": 1, "max_input_channels": 2, "default_samplerate": 48000.0},
        ]
        self.streams = []

    def query_devices(self, device=None):
        return self.devices if device is None else self.devices[device]

    def query_hostapis(self, index=None):
        hosts = [{"name": "MME"}, {"name": "Windows WASAPI"}]
        return hosts if index is None else hosts[index]

    def InputStream(self, **kwargs):
        stream = types.SimpleNamespace(kwargs=kwargs, callback=kwargs["callback"])
        stream.__enter__ = lambda: stream
        self.streams.append(stream)
        return stream


@pytest.fixture
def fake_sd(monkeypatch):
    fake = FakeSounddevice()
    monkeypatch.setitem(sys.modules, "sounddevice", fake)
    return fake


class TestDevices:
    def test_a_name_picks_the_wasapi_one_when_there_is_one(self, fake_sd):
        assert live.resolve_device(fake_sd, "Focusrite") == 3
        assert live.resolve_device(fake_sd, "earpods") == 1
        assert live.resolve_device(fake_sd, "2") == 2
        assert live.resolve_device(fake_sd, None) == 1

    def test_an_unknown_name_is_an_error(self, fake_sd):
        with pytest.raises(SystemExit):
            live.resolve_device(fake_sd, "nothing")

    def test_the_list_marks_the_default_and_what_looks_like_an_interface(self, fake_sd, capsys):
        assert live.main(["devices"]) == 0
        out = capsys.readouterr().out
        assert "Speakers" not in out
        assert "default" in out and "audio interface" in out and "WASAPI" in out


class TestSession:
    def args(self, **over):
        base = dict(device="Focusrite", channel="auto", rate=None, record=None, lab=None, window=0.4, hop=0.05, gate=-50.0,
                    stick=0.25, power=0.5, hf_weight=0.5, peak_floor=0.02, seventh_margin=0.12, tuning=None)
        base.update(over)
        return types.SimpleNamespace(**base)

    def feed(self, session, audio, channels=2, block=512):
        for i in range(0, len(audio), block):
            mono = audio[i:i + block]
            session.stream.callback(np.stack([mono] + [np.zeros_like(mono)] * (channels - 1), axis=1), len(mono), None, None)

    def test_opens_the_device_at_its_own_rate_and_listens_to_the_loud_channel(self, fake_sd):
        session = live.Session(self.args())
        assert session.sr == 48000 and session.device == 3
        assert fake_sd.streams[0].kwargs["samplerate"] == 48000 and fake_sd.streams[0].kwargs["channels"] == 2
        self.feed(session, np.concatenate([strum(SHAPES["E:min"], sr=48000)]))
        frames = session.poll()
        assert frames and frames[-1].chord == "E:min"

    def test_the_take_can_be_recorded(self, fake_sd, tmp_path):
        path = tmp_path / "take.wav"
        session = live.Session(self.args(record=str(path)))
        self.feed(session, strum(SHAPES["C:maj"], 1.0, sr=48000))
        session.poll()
        session.close()
        data, sr = sf.read(path)
        assert sr == 48000 and len(data) == 48000 and np.abs(data).max() > 0.01

    def test_full_scale_input_and_no_signal_are_called_out(self, fake_sd, capsys):
        session = live.Session(self.args())
        self.feed(session, np.ones(2048, dtype=np.float32))
        session.poll()
        assert "full scale" in capsys.readouterr().err
        quiet = live.Session(self.args())
        self.feed(quiet, np.zeros(48000 * 8, dtype=np.float32), block=4096)
        quiet.poll()
        assert "nothing heard" in capsys.readouterr().err


class TestFileAndReplay:
    def test_a_recording_is_scored_against_its_chart(self, tmp_path, capsys):
        audio = np.concatenate([strum(SHAPES[c]) for c in ["C:maj", "G:maj", "A:min"]])
        wav, chart = tmp_path / "a.wav", tmp_path / "a.lab"
        sf.write(wav, audio, SR)
        chart.write_text("0 2 C:maj\n2 4 G:maj\n4 6 A:min\n", encoding="utf-8")
        out_lab = tmp_path / "out.lab"
        assert live.main(["file", str(wav), "--ref", str(chart), "--align", "--lab", str(out_lab)]) == 0
        text = capsys.readouterr().out
        assert "majmin 9" in text or "majmin 100" in text
        assert out_lab.read_text(encoding="utf-8").count("\n") >= 3

    def test_the_replay_of_a_dataset_song_reports_the_set(self, tmp_path, monkeypatch, capsys):
        import lab
        monkeypatch.setattr(lab, "DATASETS", tmp_path / "datasets")
        folder = lab.DATASETS / "demo"
        (folder / "s").mkdir(parents=True)
        sf.write(folder / "s" / "guitar.wav", np.concatenate([strum(SHAPES["C:maj"]), strum(SHAPES["G:maj"])]), SR)
        (folder / "s.lab").write_text("0 2 C:maj\n2 4 G:maj\n", encoding="utf-8")
        (folder / "manifest.json").write_text('{"songs": [{"name": "S", "song_dir": "s", "ref": "s.lab"}]}', encoding="utf-8")
        assert live.main(["replay", "demo", "--align", "--stems", "guitar"]) == 0
        out = capsys.readouterr().out
        assert "demo through the live engine" in out and "S " in out


class TestPlot:
    def test_draws_frames_and_keeps_a_history(self, tmp_path):
        pytest.importorskip("matplotlib")
        import matplotlib
        matplotlib.use("Agg")
        plot = live.LivePlot(capo=0)
        frames = run(np.concatenate([strum(SHAPES["C:maj"]), strum(SHAPES["G:maj"])]))
        for i in range(0, len(frames), 10):
            plot.update(frames[i:i + 10])
        assert [r[2] for r in plot.runs][-1] == "G"
        assert plot.chord_text.get_text() == "G"
        plot.fig.savefig(tmp_path / "live.png")
        assert (tmp_path / "live.png").stat().st_size > 5000
