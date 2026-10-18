"""
Real-time pitch and chord detection: plug a guitar into an audio interface and watch what it hears.

    python chord_lab\\live.py devices                     # list inputs (pick a WASAPI one)
    python chord_lab\\live.py listen --device 3 --plot    # a window: chord, note and cents, chroma, history
    python chord_lab\\live.py listen --device Focusrite   # the terminal only
    python chord_lab\\live.py file take.wav --ref take.lab     # replay a recording through the same engine
    python chord_lab\\live.py replay tabs mercy --align        # replay a data-set song and score it

Per 50 ms it shows the note when one rings clearly (name and cents, like a tuner)
and the chord otherwise, decoded with the app's chord templates, switch costs and
slash-chord rule, but causally: there is no look-ahead, so a new chord shows
about a quarter of a second after the strum. The instrument's tuning is followed
from the spectrum, so a guitar a little flat still reads in its own key. See
realtime.py for how, and README.md for what to expect.

`listen` can keep the take: --record writes the audio (so it can be replayed or
imported as a data-set song) and --lab the chords it showed.
"""

import argparse
import queue
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import lab
import realtime as rt

import numpy as np
import soundfile as sf

import chord_eval
import processor

INTERFACE_HINTS = ("focusrite", "scarlett", "behringer", "presonus", "audient", "motu", "steinberg", "interface", "usb audio")
FIRST_SECONDS_HINT = 6.0


def add_analysis_flags(ap: argparse.ArgumentParser) -> None:
    d = rt.Settings()
    g = ap.add_argument_group("analysis")
    g.add_argument("--window", type=float, default=d.window, help="seconds of sound each chord is read from (default %(default)s; shorter is quicker, blurrier on low strings)")
    g.add_argument("--hop", type=float, default=d.hop, help="seconds between updates (default %(default)s)")
    g.add_argument("--gate", type=float, default=d.gate_db, help="dBFS below which it hears silence (default %(default)s)")
    g.add_argument("--stick", type=float, default=d.stick, help="seconds a new chord has to win before it shows (default %(default)s)")
    g.add_argument("--power", type=float, default=d.power, help="compression of the spectrum before folding (default %(default)s)")
    g.add_argument("--hf-weight", type=float, default=d.hf_weight, help="weight of notes above E5 (default %(default)s)")
    g.add_argument("--peak-floor", type=float, default=d.peak_floor, help="spectral peaks weaker than this share of the strongest are ignored (default %(default)s)")
    g.add_argument("--seventh-margin", type=float, default=d.seventh_margin, help="how much better a seventh chord has to fit than the plain chord (default %(default)s; the app uses 0.07 on its own chroma)")
    g.add_argument("--tuning", type=float, default=None, help="fix the instrument's offset from A440 in cents instead of following it")


def settings_from(args) -> rt.Settings:
    return rt.Settings(window=args.window, hop=args.hop, gate_db=args.gate, stick=args.stick,
                       power=args.power, hf_weight=args.hf_weight, peak_floor=args.peak_floor,
                       seventh_margin=args.seventh_margin, tuning=args.tuning)


class ChannelPicker:
    """
    Mono from a multi-channel block. `auto` follows the louder channel: an
    interface with the guitar in input 1 leaves input 2 silent, and averaging
    would halve the signal for nothing. `mix` averages; a number picks a channel.
    """

    def __init__(self, mode: str):
        self.mode = mode
        self.energy = None

    def __call__(self, block: np.ndarray) -> np.ndarray:
        if block.ndim == 1:
            return block
        if block.shape[1] == 1:
            return block[:, 0]
        if self.mode == "mix":
            return block.mean(axis=1)
        if self.mode == "auto":
            now = (block.astype(np.float64) ** 2).mean(axis=0)
            self.energy = now if self.energy is None else 0.98 * self.energy + 0.02 * now
            return block[:, int(np.argmax(self.energy))]
        return block[:, min(int(self.mode), block.shape[1] - 1)]


def load_sounddevice():
    try:
        import sounddevice as sd
    except ImportError:
        raise SystemExit("sounddevice is not installed: pip install -r chord_lab\\requirements-lab.txt")
    return sd


def inputs(sd) -> list:
    hosts = sd.query_hostapis()
    return [(i, d, hosts[d["hostapi"]]["name"]) for i, d in enumerate(sd.query_devices()) if d["max_input_channels"] > 0]


def resolve_device(sd, spec: str | None) -> int:
    if spec is None:
        return sd.default.device[0]
    if spec.isdigit():
        return int(spec)
    matches = [(i, host) for i, d, host in inputs(sd) if spec.lower() in d["name"].lower()]
    if not matches:
        raise SystemExit(f"No input device matches {spec!r}; run `live.py devices`.")
    wasapi = [i for i, host in matches if "WASAPI" in host]
    return (wasapi or [i for i, _ in matches])[0]


def cmd_devices(args) -> int:
    sd = load_sounddevice()
    default = sd.default.device[0]
    print("Input devices (WASAPI gives the lowest latency on Windows; an interface often shows once per host API):\n")
    for i, d, host in inputs(sd):
        name = d["name"].replace("\n", " ")
        flags = ("  <- default" if i == default else "") + ("  <- looks like an audio interface" if any(h in name.lower() for h in INTERFACE_HINTS) else "")
        print(f"{i:>3}  {host:<22} {name[:52]:<52} {d['max_input_channels']} in  {d['default_samplerate']:.0f} Hz{flags}")
    print("\nUse the number or a part of the name: live.py listen --device 12   or   --device Focusrite")
    return 0


def level_bar(db: float, width: int = 12) -> str:
    filled = int(np.clip((db + 60.0) / 60.0, 0.0, 1.0) * width)
    return "#" * filled + "." * (width - filled)


def status_line(f: rt.Frame, capo: int) -> str:
    if f.silent:
        return f"{level_bar(f.level_db)} {f.level_db:>4.0f} dB | (quiet)"
    note = f"{f.pitch.name:>4} {f.pitch.cents:+3.0f}c" if f.mono else "          "
    alts = " ".join(rt.pretty(c, None, capo) for c, _ in f.alternatives)
    return (f"{level_bar(f.level_db)} {f.level_db:>4.0f} dB | {note} | {rt.pretty(f.chord, f.bass, capo):<9} "
            f"fit {f.fit:.2f} | also {alts} | tuning {f.tuning:+.0f}c")


class TerminalView:
    """A status line that refreshes in place (on a terminal) and one line per chord change."""

    def __init__(self, capo: int):
        self.capo = capo
        self.last = None
        self.tty = sys.stdout.isatty()

    def show(self, f: rt.Frame) -> None:
        label = None if f.silent else rt.pretty(f.chord, f.bass, self.capo)
        if label and label != self.last:
            sys.stdout.write(("\r" + " " * 110 + "\r" if self.tty else "") + f"{f.t:7.2f}s  {label}\n")
        self.last = label
        if self.tty:
            sys.stdout.write("\r" + status_line(f, self.capo).ljust(110))
        sys.stdout.flush()


class LivePlot:
    """A window: the chord in big letters, the note and its cents, the chroma, and the last seconds of chords."""

    BG, FG, ACCENT, DIM = "#1a1a2e", "#e8e8f0", "#f59e0b", "#6b6b85"

    def __init__(self, capo: int = 0, history: float = 20.0):
        import matplotlib.pyplot as plt
        from matplotlib.patches import Rectangle

        self.plt, self.Rectangle = plt, Rectangle
        self.capo, self.span = capo, history
        self.runs = []
        self.fig = plt.figure(figsize=(9, 5.4), facecolor=self.BG)
        grid = self.fig.add_gridspec(3, 2, height_ratios=[2.6, 1.3, 1.0], width_ratios=[2.2, 1], hspace=0.35, wspace=0.12,
                                     left=0.06, right=0.97, top=0.95, bottom=0.08)
        self.ax_chord = self.fig.add_subplot(grid[0, 0])
        self.ax_note = self.fig.add_subplot(grid[0, 1])
        self.ax_chroma = self.fig.add_subplot(grid[1, :])
        self.ax_hist = self.fig.add_subplot(grid[2, :])
        for ax in (self.ax_chord, self.ax_note):
            ax.axis("off")
        self.chord_text = self.ax_chord.text(0.5, 0.55, "-", ha="center", va="center", fontsize=78, color=self.FG, transform=self.ax_chord.transAxes)
        self.sub_text = self.ax_chord.text(0.5, 0.06, "", ha="center", va="center", fontsize=11, color=self.DIM, transform=self.ax_chord.transAxes)
        self.note_text = self.ax_note.text(0.5, 0.62, "", ha="center", va="center", fontsize=40, color=self.ACCENT, transform=self.ax_note.transAxes)
        self.cents_text = self.ax_note.text(0.5, 0.28, "", ha="center", va="center", fontsize=13, color=self.FG, transform=self.ax_note.transAxes)
        self.ax_note.plot([0.1, 0.9], [0.12, 0.12], color=self.DIM, lw=2, transform=self.ax_note.transAxes)
        self.needle = self.ax_note.plot([0.5], [0.12], marker="v", color=self.ACCENT, ms=11, ls="", transform=self.ax_note.transAxes)[0]
        self.bars = self.ax_chroma.bar(range(12), np.zeros(12), color=self.DIM)
        self.ax_chroma.set_ylim(0, 1.05)
        self.ax_chroma.set_xticks(range(12), processor.NOTE_NAMES)
        for ax in (self.ax_chroma, self.ax_hist):
            ax.set_facecolor(self.BG)
            ax.tick_params(colors=self.FG, labelsize=8)
            for spine in ax.spines.values():
                spine.set_color(self.DIM)
        self.ax_chroma.set_yticks([])
        self.ax_hist.set_yticks([])
        self.ax_hist.set_xlabel("seconds ago", color=self.DIM, fontsize=8)

    def update(self, frames: list) -> None:
        if not frames:
            return
        f = frames[-1]
        label = "-" if f.silent else rt.pretty(f.chord, f.bass, self.capo)
        self.chord_text.set_text(label)
        self.chord_text.set_color(self.DIM if f.silent or f.mono else self.FG)
        self.sub_text.set_text("quiet" if f.silent else
                               f"fit {f.fit:.2f}   also {'  '.join(rt.pretty(c, None, self.capo) for c, _ in f.alternatives)}"
                               f"   (instrument {f.tuning:+.0f} cents from A440)")
        if f.mono and f.pitch:
            self.note_text.set_text(f.pitch.name)
            self.cents_text.set_text(f"{f.pitch.cents:+.0f} cents")
            self.needle.set_xdata([0.5 + 0.4 * float(np.clip(f.pitch.cents, -50, 50)) / 50.0])
        else:
            self.note_text.set_text("")
            self.cents_text.set_text("")
            self.needle.set_xdata([0.5])
        peak = float(f.chroma.max())
        for bar, value in zip(self.bars, f.chroma / peak if peak > 0 else f.chroma):
            bar.set_height(value)
            bar.set_color(self.ACCENT if value > 0.55 else self.DIM)
        for fr in frames:
            self._push(fr)
        self._draw_history(f.t)
        self.fig.canvas.draw_idle()

    def _push(self, f: rt.Frame) -> None:
        label = None if f.silent else rt.pretty(f.chord, f.bass, self.capo)
        if self.runs and self.runs[-1][2] == label:
            self.runs[-1][1] = f.t
        else:
            self.runs.append([f.t, f.t, label])

    def _draw_history(self, now: float) -> None:
        ax = self.ax_hist
        for patch in list(ax.patches) + list(ax.texts):
            patch.remove()
        self.runs = [r for r in self.runs if r[1] > now - self.span]
        for start, end, label in self.runs:
            if not label:
                continue
            x0, x1 = max(start, now - self.span) - now, end - now
            ax.add_patch(self.Rectangle((x0, 0), max(x1 - x0, 0.05), 1, color=self.plt.cm.tab20c(0.04 + 0.9 * (ord(label[0]) % 12) / 12), alpha=0.8))
            if x1 - x0 > 0.8:
                ax.text((x0 + x1) / 2, 0.5, label, ha="center", va="center", fontsize=9, color="black")
        ax.set_xlim(-self.span, 0)
        ax.set_ylim(0, 1)


class Session:
    """The audio interface's input stream, the channel choice and the engine."""

    def __init__(self, args):
        self.sd = load_sounddevice()
        self.device = resolve_device(self.sd, args.device)
        info = self.sd.query_devices(self.device)
        self.name = info["name"].replace("\n", " ")
        self.sr = int(args.rate or info["default_samplerate"])
        channels = max(1, min(2, info["max_input_channels"]))
        self.engine = rt.LiveAnalyzer(self.sr, settings_from(args))
        self.picker = ChannelPicker(args.channel)
        self.queue = queue.Queue()
        self.frames = []
        self.keep = bool(args.lab)
        self.recorder = sf.SoundFile(args.record, "w", self.sr, 1, subtype="PCM_16") if args.record else None
        self.peak = 0.0
        self.heard = False
        self.warned = set()
        self.stream = self.sd.InputStream(device=self.device, channels=channels, samplerate=self.sr,
                                          dtype="float32", latency="low", callback=self._callback)

    def _callback(self, indata, frames, time_info, status) -> None:
        if status:
            self.queue.put(("status", str(status)))
        self.queue.put(("audio", indata.copy()))

    def poll(self) -> list:
        out = []
        while True:
            try:
                kind, data = self.queue.get_nowait()
            except queue.Empty:
                break
            if kind == "status":
                print(f"\n[audio] {data}", file=sys.stderr)
                continue
            mono = self.picker(data)
            self.peak = max(self.peak, float(np.abs(mono).max(initial=0.0)))
            if self.recorder:
                self.recorder.write(mono)
            out += self.engine.feed(mono)
        if self.keep:
            self.frames += out
        self._hints(out)
        return out

    def _hints(self, frames: list) -> None:
        if any(not f.silent for f in frames):
            self.heard = True
        if self.peak >= 0.99 and "clip" not in self.warned:
            self.warned.add("clip")
            print("\n[input] the signal reaches full scale: lower the gain on the interface or the chords will smear.", file=sys.stderr)
        if frames and not self.heard and frames[-1].t > FIRST_SECONDS_HINT and "quiet" not in self.warned:
            self.warned.add("quiet")
            print("\n[input] nothing heard yet. Check the input gain and the instrument/line switch on the interface, "
                  "that the guitar is in the input this device reads (try --channel 0 or 1), and Windows "
                  "Settings > Privacy > Microphone (desktop apps must be allowed).", file=sys.stderr)

    def close(self) -> None:
        if self.recorder:
            self.recorder.close()


def finish(frames: list, args, hop: float) -> None:
    if args.lab and frames:
        from tab_chords import write_lab
        write_lab(rt.segments(frames, args.delay, hop), args.lab)
        print(f"wrote {args.lab}")


def cmd_listen(args) -> int:
    session = Session(args)
    s = session.engine.s
    print(f"Listening to {session.name} (device {session.device}, {session.sr} Hz, channel {args.channel}). "
          f"Chord window {s.window:.2f} s, update every {s.hop * 1000:.0f} ms, shows a change after ~{session.engine.latency + s.stick / 2:.2f} s. Ctrl+C stops.")
    with session.stream:
        try:
            if args.plot:
                import matplotlib.pyplot as plt
                from matplotlib.animation import FuncAnimation

                plot = LivePlot(args.capo)
                animation = FuncAnimation(plot.fig, lambda _: plot.update(session.poll()), interval=40, cache_frame_data=False)
                plt.show()
                del animation
            else:
                import time
                view = TerminalView(args.capo)
                while True:
                    for frame in session.poll():
                        view.show(frame)
                    time.sleep(0.01)
        except KeyboardInterrupt:
            pass
    session.close()
    print()
    finish(session.frames, args, s.hop)
    return 0


def mono_from(path, channel: str) -> tuple:
    data, sr = sf.read(path, dtype="float32", always_2d=True)
    return ChannelPicker(channel if channel != "auto" else "mix")(data), sr


def run_engine(y: np.ndarray, sr: float, settings: rt.Settings, block: int = 2048) -> list:
    engine = rt.LiveAnalyzer(sr, settings)
    frames = []
    for i in range(0, len(y), block):
        frames += engine.feed(y[i:i + block])
    return frames


def score_frames(frames: list, settings: rt.Settings, ref_path, duration: float, delay: float, align: bool) -> dict:
    estimate = rt.segments(frames, delay, settings.hop)
    reference = chord_eval.read_lab(ref_path)
    offset = chord_eval.best_offset(reference, estimate)["offset"] if align else 0.0
    shifted = chord_eval.shift(estimate, offset) if offset else estimate
    result = chord_eval.evaluate(reference, shifted, duration)
    result.update(offset=offset, segments=estimate)
    return result


def cmd_file(args) -> int:
    settings = settings_from(args)
    y, sr = mono_from(args.path, args.channel)
    frames = run_engine(y, sr, settings)
    view = TerminalView(args.capo)
    view.tty = False
    for f in frames:
        view.show(f)
    if args.ref:
        result = score_frames(frames, settings, args.ref, len(y) / sr, args.delay, args.align)
        print("\n" + "  ".join(f"{lvl} {result['levels'][lvl]['score'] * 100:.1f}%" for lvl in lab.LEVELS)
              + (f"   (shifted {result['offset']:+.2f} s: the delay it really has is about {args.delay - result['offset']:.2f} s)" if args.align else ""))
    finish(frames, args, settings.hop)
    return 0


def song_mix(song_dir: str, stems: list | None) -> np.ndarray:
    paths, source = chord_eval._stem_paths(Path(song_dir))
    if stems:
        chosen = {n: p for n, p in paths.items() if n in stems}
        if not chosen:
            raise SystemExit(f"{song_dir} has none of the stems {stems}; it has {sorted(paths)}")
    else:
        chosen = processor._harmonic_stem_paths(paths) or ({"mix": source} if source else paths)
    return processor._sum_audio_files(chosen)


def cmd_replay(args) -> int:
    import json

    dataset = lab.load_set(args.dataset)
    songs = [lab.find_song(dataset, args.song)] if args.song else dataset.songs
    settings = settings_from(args)
    stems = args.stems.split(",") if args.stems else None
    align = args.align or dataset.align
    results = []
    for entry in songs:
        print(f"  {entry['name']} ...", file=sys.stderr, flush=True)
        frames = run_engine(song_mix(entry["song_dir"], stems), processor.SAMPLE_RATE, settings)
        duration = len(frames) * settings.hop
        result = score_frames(frames, settings, entry["ref"], duration, args.delay, align)
        result["name"] = entry["name"]
        results.append(result)

    print(f"\n{dataset.name} through the live engine (window {settings.window} s, stick {settings.stick} s, "
          f"{'stems ' + args.stems if args.stems else 'harmonic mix'}{', aligned' if align else ''})")
    print(f"{'song':<34}" + "".join(f"{lvl:>10}" for lvl in lab.LEVELS) + f"{'shift s':>10}")
    for r in results:
        print(f"{r['name'][:33]:<34}" + "".join(f"{r['levels'][lvl]['score'] * 100:>9.1f}%" for lvl in lab.LEVELS) + f"{r['offset']:>+10.2f}")
    if len(results) > 1:
        print(f"{'ALL (time-weighted)':<34}" + "".join(f"{lab.weighted(results, lvl) * 100:>9.1f}%" for lvl in lab.LEVELS))
        print(f"{'  95% interval':<34}" + "".join(
            f"{'%.0f-%.0f' % tuple(x * 100 for x in lab.bootstrap(results, lvl)):>10}" for lvl in lab.LEVELS))
        baseline = lab.RESULTS / f"{dataset.name}-baseline.json"
        if baseline.exists():
            before = json.loads(baseline.read_text(encoding="utf-8"))["summary"]
            print(f"{'  offline detector (baseline)':<34}" + "".join(f"{before[lvl]['score'] * 100:>9.1f}%" for lvl in lab.LEVELS))
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="command", required=True)

    sub.add_parser("devices", help="list the audio inputs").set_defaults(run=cmd_devices)

    p = sub.add_parser("listen", help="listen to an input device")
    p.add_argument("--device", help="device number or part of its name (default: the system input)")
    p.add_argument("--channel", default="auto", help="auto (the louder one), mix, 0 or 1 (default %(default)s)")
    p.add_argument("--rate", type=int, help="sample rate (default: the device's own)")
    p.add_argument("--plot", action="store_true", help="show a window instead of the terminal line")
    p.add_argument("--capo", type=int, default=0, help="name chords as the shapes played with the capo on this fret")
    p.add_argument("--record", help="also write the incoming audio (mono WAV)")
    p.add_argument("--lab", help="also write the chords shown, as a .lab chart, when you stop")
    p.add_argument("--delay", type=float, default=0.3, help="seconds a chord's start is placed before the frame that showed it")
    add_analysis_flags(p)
    p.set_defaults(run=cmd_listen)

    p = sub.add_parser("file", help="run a recording through the engine")
    p.add_argument("path")
    p.add_argument("--ref", help="reference chart (.lab) to score against")
    p.add_argument("--align", action="store_true", help="search a constant offset before scoring (it measures the delay)")
    p.add_argument("--channel", default="mix")
    p.add_argument("--capo", type=int, default=0)
    p.add_argument("--lab")
    p.add_argument("--delay", type=float, default=0.3)
    add_analysis_flags(p)
    p.set_defaults(run=cmd_file)

    p = sub.add_parser("replay", help="run data-set songs through the engine and score them")
    p.add_argument("dataset")
    p.add_argument("song", nargs="?", help="part of one song's name (default: all)")
    p.add_argument("--stems", help="comma-separated stems to use instead of the harmonic mix, e.g. guitar")
    p.add_argument("--align", action="store_true", help="search a constant offset (always on for sets that need it)")
    p.add_argument("--delay", type=float, default=0.3)
    add_analysis_flags(p)
    p.set_defaults(run=cmd_replay)

    args = ap.parse_args(argv)
    return args.run(args)


if __name__ == "__main__":
    sys.exit(main())
