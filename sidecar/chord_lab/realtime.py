"""
Real-time pitch and chord analysis of one audio stream (a guitar, a recording).

The engine is pure: `LiveAnalyzer.feed(samples)` takes mono samples in blocks of
any size and returns one `Frame` per hop. It does no audio I/O and no drawing,
so the same code listens to an audio interface in `live.py listen`, replays a
file in `live.py file`, and runs in the tests. Per frame:

  pitch   YIN on the last ~46 ms: the note being played and how far it is from
          pitch, when one note rings clearly (`Frame.mono`).
  chord   a chroma folded from the last `window` seconds of spectrum (the
          strongest peak in every semitone band, so leakage and the harmonics
          between notes count for little), matched against the app's chord
          templates (`processor.CHORD_TEMPLATES`, sevenths pay
          `processor._SEVENTH_MARGIN`) and decoded by a causal Viterbi pass that
          uses the app's switch costs: a new chord has to win for about `stick`
          seconds before it shows. The bass note makes a slash chord, as in the app.
  tuning  the instrument's offset from A440, followed from the spectral peaks,
          so a guitar a few cents flat is still read in tune with itself.

What it is not: the offline detector. It cannot look ahead (no beat windows, no
hindsight), so it answers later and less steadily than the app's chords; the
price of being live.
"""

from dataclasses import dataclass, field

import numpy as np
from scipy import signal
from scipy.ndimage import gaussian_filter1d

import lab

processor = lab.processor

LOW_MIDI, HIGH_MIDI = 38, 100
BASS_MIDI = (38, 57)
HF_START_MIDI = 76
TUNING_BINS = 100
FUNDAMENTAL_SHARE = 0.1
BASS_SHARE = 0.3
PEAKS_HZ = (60.0, 2700.0)
NOTE_NAMES = processor.NOTE_NAMES

_QUALITY_TEXT = {"maj": "", "min": "m", "7": "7", "maj7": "maj7", "min7": "m7"}


@dataclass
class Settings:
    window: float = 0.4
    hop: float = 0.05
    gate_db: float = -50.0
    power: float = 0.5
    hf_weight: float = 0.5
    peak_floor: float = 0.02
    seventh_margin: float = 0.12
    stick: float = 0.25
    tuning: float | None = None
    fmin: float = 60.0
    fmax: float = 1100.0
    mono_clarity: float = 0.88


@dataclass
class Pitch:
    f0: float
    midi: float
    name: str
    cents: float
    clarity: float


@dataclass
class Frame:
    t: float
    level_db: float
    silent: bool
    pitch: Pitch | None
    mono: bool
    chroma: np.ndarray
    chord: str | None
    bass: str | None
    fit: float
    best: str | None
    alternatives: list = field(default_factory=list)
    tuning: float = 0.0


def note_name(midi: int) -> str:
    return f"{NOTE_NAMES[midi % 12]}{midi // 12 - 1}"


def pretty(chord: str | None, bass: str | None = None, capo: int = 0) -> str:
    """'A:min7' + bass 'C' -> 'Am7/C'; with a capo the shapes are named instead of the sounds."""
    if not chord:
        return "-"
    root, quality = chord.split(":")
    names = [NOTE_NAMES[(NOTE_NAMES.index(n) - capo) % 12] for n in (root, bass)] if bass else \
        [NOTE_NAMES[(NOTE_NAMES.index(root) - capo) % 12]]
    text = names[0] + _QUALITY_TEXT.get(quality, quality)
    return f"{text}/{names[1]}" if bass else text


def yin(x: np.ndarray, sr: float, fmin: float = 60.0, fmax: float = 1100.0, threshold: float = 0.15):
    """
    (f0 Hz, clarity 0-1) of one frame by YIN (de Cheveigne and Kawahara 2002), or
    None when the frame is too short. Clarity is 1 minus the normalised
    difference at the chosen period: near 1 for one steady note, low for a chord
    or noise, which is how the tool tells a note from a strum.
    """
    tau_max = min(int(sr / fmin), len(x) // 2 - 1)
    tau_min = max(2, int(sr / fmax))
    w = len(x) - tau_max
    if w <= tau_min:
        return None
    x = np.asarray(x, dtype=np.float64)
    x = x - x.mean()
    energy = np.concatenate(([0.0], np.cumsum(x * x)))
    taus = np.arange(tau_max + 1)
    nfft = 1 << (len(x) + w - 1).bit_length()
    corr = np.fft.irfft(np.fft.rfft(x, nfft) * np.conj(np.fft.rfft(x[:w], nfft)), nfft)[: tau_max + 1]
    d = energy[w] + (energy[w + taus] - energy[taus]) - 2.0 * corr
    cm = np.ones(tau_max + 1)
    cm[1:] = d[1:] * taus[1:] / (np.cumsum(d[1:]) + 1e-12)

    below = np.nonzero(cm[tau_min:tau_max] < threshold)[0]
    if len(below):
        tau = tau_min + int(below[0])
        while tau + 1 < tau_max and cm[tau + 1] < cm[tau]:
            tau += 1
    else:
        tau = tau_min + int(np.argmin(cm[tau_min:tau_max]))
    shift = 0.0
    if 1 <= tau < tau_max:
        a, b, c = cm[tau - 1], cm[tau], cm[tau + 1]
        denom = a - 2.0 * b + c
        if abs(denom) > 1e-12:
            shift = float(np.clip(0.5 * (a - c) / denom, -1.0, 1.0))
    return sr / (tau + shift), float(np.clip(1.0 - cm[tau], 0.0, 1.0))


class Decoder:
    """Causal Viterbi over the app's chord templates; one `step` per frame."""

    def __init__(self, hop: float, stick: float, margin: float | None = None):
        self.names = list(processor.CHORD_TEMPLATES) + list(processor.SEVENTH_TEMPLATES)
        matrix = np.stack([{**processor.CHORD_TEMPLATES, **processor.SEVENTH_TEMPLATES}[n] for n in self.names]).astype(float)
        self.matrix = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
        self.prior = np.zeros(len(self.names))
        self.prior[len(processor.CHORD_TEMPLATES):] -= processor._SEVENTH_MARGIN if margin is None else margin
        n = len(self.names)
        self.costs = processor._transition_costs(self.names + [processor._NO_CHORD_LABEL])[:n, :n] * (stick / hop)
        self.score = np.zeros(n)

    def step(self, chroma: np.ndarray) -> tuple:
        """(index of the chord now decoded, every chord's fit to this frame)."""
        norm = np.linalg.norm(chroma)
        fits = self.matrix @ (chroma / norm) if norm > 1e-9 else np.zeros(len(self.names))
        carried = (self.score[:, None] - self.costs).max(axis=0)
        self.score = carried + fits + self.prior
        self.score -= self.score.max()
        return int(np.argmax(self.score)), fits


class LiveAnalyzer:
    def __init__(self, sr: float, settings: Settings | None = None):
        self.sr = float(sr)
        self.s = settings or Settings()
        self.hop_samples = max(1, round(self.s.hop * self.sr))
        self.window_samples = max(self.hop_samples, round(self.s.window * self.sr))
        self.yin_samples = 1 << int(np.ceil(np.log2(2.2 * self.sr / self.s.fmin)))
        self.level_samples = max(1, round(0.1 * self.sr))
        self.buf = np.zeros(max(self.window_samples, self.yin_samples), dtype=np.float32)
        self.total = 0
        self.pending = 0
        self.hann = np.hanning(self.window_samples)
        self.nfft = 1 << int(np.ceil(np.log2(2 * self.window_samples)))
        self.df = self.sr / self.nfft
        self.sos = signal.butter(2, 55.0, "highpass", fs=self.sr, output="sos")
        self.zi = np.zeros((self.sos.shape[0], 2))
        self.midis = np.arange(LOW_MIDI, HIGH_MIDI + 1)
        self.band_weights = np.where(self.midis <= HF_START_MIDI, 1.0, self.s.hf_weight)
        self.is_bass = (self.midis >= BASS_MIDI[0]) & (self.midis <= BASS_MIDI[1])
        self.decoder = Decoder(self.s.hop, self.s.stick, self.s.seventh_margin)
        self.tuning_hist = self._prior_hist()
        self.tuning_cents = self.s.tuning if self.s.tuning is not None else 0.0
        self.hist_decay = 0.5 ** (self.s.hop / 8.0)
        self.chord = None

    @property
    def latency(self) -> float:
        """Seconds a chord change takes to show at the very least: half a window of new sound plus the evidence time."""
        return self.s.window / 2 + self.s.hop

    def _prior_hist(self) -> np.ndarray:
        hist = np.zeros(TUNING_BINS)
        hist[TUNING_BINS // 2] = 5.0
        return hist

    def feed(self, samples) -> list:
        x = np.asarray(samples, dtype=np.float32).ravel()
        if len(x):
            x, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
            x = x.astype(np.float32)
        frames, i = [], 0
        while i < len(x):
            take = min(len(x) - i, self.hop_samples - self.pending)
            chunk = x[i:i + take]
            self.buf = np.concatenate((self.buf[take:], chunk)) if take < len(self.buf) else chunk[-len(self.buf):]
            self.total += take
            self.pending += take
            i += take
            if self.pending == self.hop_samples:
                self.pending = 0
                if self.total >= self.window_samples:
                    frames.append(self._analyze())
        return frames

    def _analyze(self) -> Frame:
        s = self.s
        recent = self.buf[-self.level_samples:].astype(np.float64)
        level = 20.0 * np.log10(np.sqrt(np.mean(recent ** 2)) + 1e-9)
        silent = level < s.gate_db
        t = self.total / self.sr
        if silent:
            return Frame(t, level, True, None, False, np.zeros(12), self.chord_name(), None, 0.0, None, [], self.tuning_cents)

        spectrum = np.abs(np.fft.rfft(self.buf[-self.window_samples:] * self.hann, self.nfft))
        found = yin(self.buf[-self.yin_samples:], self.sr, s.fmin, s.fmax)
        pitch = None
        if found and found[1] > 0.6 and self._has_fundamental(spectrum, found[0]):
            midi = 69.0 + 12.0 * np.log2(found[0] / 440.0)
            nearest = int(round(midi))
            pitch = Pitch(found[0], midi, note_name(nearest), (midi - nearest) * 100.0, found[1])

        freqs, mags = self._peaks(spectrum)
        if s.tuning is None:
            self._follow_tuning(freqs, mags)
        chroma, bass_vec = self._fold(freqs, mags)

        index, fits = self.decoder.step(chroma)
        chord = self.decoder.names[index]
        self.chord = chord
        bass = processor._slash_bass(chord, bass_vec)
        order = np.argsort(-(fits + self.decoder.prior))
        alternatives = [(self.decoder.names[j], float(fits[j])) for j in order[:4] if j != index][:3]
        best = self.decoder.names[int(order[0])]
        mono = pitch is not None and pitch.clarity >= s.mono_clarity
        return Frame(t, level, False, pitch, mono, chroma, chord, bass, float(fits[index]), best, alternatives, self.tuning_cents)

    def chord_name(self):
        return self.chord

    def _has_fundamental(self, spectrum: np.ndarray, f0: float) -> bool:
        """
        A major chord's partials form the harmonic series of a note an octave
        below its root, so YIN finds a clear period there that nothing plays.
        A real note has energy at its own fundamental; that missing is the tell.
        """
        lo, hi = int(0.97 * f0 / self.df), int(1.03 * f0 / self.df) + 1
        band = spectrum[int(40.0 / self.df):int(2000.0 / self.df)]
        return band.max() > 0 and spectrum[lo:hi].max() >= FUNDAMENTAL_SHARE * band.max()

    def _peaks(self, spectrum: np.ndarray) -> tuple:
        """
        (frequencies, magnitudes relative to the strongest) of the spectrum's real
        peaks, refined between bins. A low note's peak is about as wide as a
        semitone there, so counting whole bands would light up its neighbours with
        the skirt; a skirt has no local maximum, a peak does.
        """
        lo, hi = int(PEAKS_HZ[0] / self.df), int(PEAKS_HZ[1] / self.df)
        seg = spectrum[lo:hi]
        top = seg.max()
        if top <= 0:
            return np.zeros(0), np.zeros(0)
        idx, _ = signal.find_peaks(seg, height=top * self.s.peak_floor, distance=max(1, int(3.0 / self.df)))
        k = idx + lo
        a, b, c = (np.log(spectrum[k + j] + 1e-12) for j in (-1, 0, 1))
        denom = a - 2.0 * b + c
        shift = np.where(np.abs(denom) > 1e-12, 0.5 * (a - c) / np.where(denom == 0, 1.0, denom), 0.0)
        return (k + np.clip(shift, -0.5, 0.5)) * self.df, spectrum[k] / top

    def _fold(self, freqs: np.ndarray, mags: np.ndarray) -> tuple:
        """(chroma, bass chroma): the strongest peak in each semitone, compressed, folded to 12 pitch classes."""
        v = np.zeros(len(self.midis))
        if len(freqs):
            midi = 69.0 + 12.0 * np.log2(freqs / 440.0) - self.tuning_cents / 100.0
            m = np.round(midi).astype(int)
            ok = (m >= LOW_MIDI) & (m <= HIGH_MIDI)
            np.maximum.at(v, m[ok] - LOW_MIDI, mags[ok] ** self.s.power)
        chroma = np.bincount(self.midis % 12, weights=self.band_weights * v, minlength=12)
        return chroma, self._bass(v)

    def _bass(self, v: np.ndarray) -> np.ndarray:
        """The lowest note that sounds clearly, as a one-hot pitch-class vector (all zero when there is none)."""
        low = np.nonzero(self.is_bass & (v >= BASS_SHARE ** self.s.power))[0]
        out = np.zeros(12)
        if len(low):
            out[self.midis[low[0]] % 12] = 1.0
        return out

    def _follow_tuning(self, freqs: np.ndarray, mags: np.ndarray) -> None:
        """Fold the peaks' offsets from the nearest semitone into a decaying histogram and take its mode."""
        self.tuning_hist *= self.hist_decay
        keep = (freqs >= 80.0) & (freqs <= 2000.0)
        if not keep.any():
            return
        offset = (1200.0 * np.log2(freqs[keep] / 440.0) + 50.0) % 100.0 - 50.0
        np.add.at(self.tuning_hist, np.clip((offset + 50.0).astype(int), 0, TUNING_BINS - 1), mags[keep])
        smooth = gaussian_filter1d(self.tuning_hist, 2.0, mode="wrap")
        self.tuning_cents = float(np.argmax(smooth) - TUNING_BINS // 2 + 0.5)


def segments(frames: list, delay: float, hop: float) -> list:
    """
    Chord segments {"start", "end", "chord"} from decoded frames. A frame's chord
    describes the sound before its time stamp, so a segment starts `delay` seconds
    earlier than the frame that first showed it; silent frames end a chord.
    """
    out = []
    for f in frames:
        label = None if f.silent else f.chord
        start = max(0.0, f.t - delay)
        if out and out[-1]["_label"] == label:
            out[-1]["end"] = start + hop
            continue
        if out:
            out[-1]["end"] = start
        out.append({"start": start, "end": start + hop, "chord": label, "_label": label})
    return [{k: v for k, v in seg.items() if k != "_label"} for seg in out if seg["chord"]]
