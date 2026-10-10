"""
Lyrics sync: place every line and word of a song's lyrics on the isolated
vocals stem.

Pipeline: parse the text -> reduce each word to the letters a CTC acoustic
model can emit -> run the model over the vocals (log-probabilities per 20 ms
frame) -> CTC forced alignment (Viterbi) pins each letter to a frame -> letters
fold back into word and line times.

The acoustic model is the English wav2vec2-base-960h from torchaudio, fetched on
first use into the models directory the shell passes in. Everything else is
plain numpy, so the algorithm is testable (and runs in CI) without torch.
"""

import http.client
import json
import os
import pickle
import re
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field

import numpy as np

USER_AGENT = "SongPracticeStudio (https://github.com/giamat90/SongPracticeStudio)"
LRCLIB_SEARCH_URL = "https://lrclib.net/api/search"

# Calibrated on 15 library songs (see wiki/lyrics.md). Per-word confidence alone
# cannot tell wrong text from right (correct songs scored 0.26-0.67, a different
# song's text 0.23-0.32), so the floor only catches gross mismatches. The
# evidence ratio - letters the model hears per letter of text - was 1.0-2.9 for
# correct lyrics and 3-9 when a third of the text was missing.
LOW_CONFIDENCE_SCORE = 0.2
LOW_COVERAGE_RATIO = 0.5
MAX_EVIDENCE_RATIO = 3.5
MIN_EVIDENCE_RATIO = 0.5
# The Viterbi keeps one int8 backpointer per (frame, state): 400M cells = 400 MB.
MAX_LATTICE_CELLS = 400_000_000
MAX_DURATION_DELTA_S = 15.0
UNKNOWN_DURATION_PENALTY_S = 8.0


class LyricsError(Exception):
    """A problem the user can act on; its message is shown as-is."""


def _log(msg: str):
    print(f"[lyrics] {msg}", file=sys.stderr, flush=True)


# ── Text ──────────────────────────────────────────────────────────────────────

_BRACKETED = re.compile(r"\[[^\]]*\]")
_FOLD = {"ß": "ss", "æ": "ae", "œ": "oe", "ø": "o", "đ": "d", "ł": "l", "ı": "i"}
_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "`": "'", "´": "'"})


def parse_lyrics(text: str) -> list[list[str]]:
    """Words of each non-empty line, as written. `[Chorus]`-style markers and LRC
    tags go; `(parenthesised)` backing vocals stay because they are sung."""
    lines = []
    for raw in text.splitlines():
        words = _BRACKETED.sub(" ", raw).split()
        if words:
            lines.append(words)
    return lines


def normalize_word(word: str, alphabet: set) -> str:
    """Reduce a written word to the letters the model can emit."""
    s = word.lower().translate(_APOSTROPHES)
    for src, dst in _FOLD.items():
        s = s.replace(src, dst)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = "".join(c for c in s if c in alphabet)
    return s.strip("'")


@dataclass
class Tokens:
    ids: list = field(default_factory=list)
    word_of: list = field(default_factory=list)
    n_words: int = 0
    line_first_word: list = field(default_factory=list)


def tokenize(lines: list, char_ids: dict) -> Tokens:
    alphabet = set(char_ids)
    out = Tokens()
    word = 0
    for line in lines:
        out.line_first_word.append(word)
        for raw in line:
            for ch in normalize_word(raw, alphabet):
                out.ids.append(char_ids[ch])
                out.word_of.append(word)
            word += 1
    out.n_words = word
    return out


# ── CTC forced alignment ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class Span:
    start: int  # first frame
    end: int  # one past the last frame
    score: float  # mean probability of the token over its frames


_NEG = -1e30


def ctc_forced_align(log_probs: np.ndarray, targets, blank: int = 0) -> list:
    """Viterbi over the CTC lattice: the most likely frame for every target token.

    `log_probs` is (frames, classes). Returns one Span per target, in order.
    """
    targets = [int(t) for t in targets]
    n_targets = len(targets)
    if n_targets == 0:
        return []
    n_frames = log_probs.shape[0]
    repeats = sum(1 for a, b in zip(targets, targets[1:]) if a == b)
    if n_frames < n_targets + repeats:
        raise LyricsError(
            "The lyrics are too long for this recording: there is not enough audio "
            "to fit every letter. Check that the text belongs to this song."
        )

    n_states = 2 * n_targets + 1
    if n_frames * n_states > MAX_LATTICE_CELLS:
        raise LyricsError(
            "This song and its lyrics are too long to align in one go. "
            "Try syncing a shorter section of the lyrics."
        )
    ext = np.full(n_states, blank, dtype=np.int64)
    ext[1::2] = targets

    can_skip = np.zeros(n_states, dtype=bool)
    for s in range(3, n_states, 2):
        can_skip[s] = ext[s] != ext[s - 2]

    lp = log_probs.astype(np.float64, copy=False)
    alpha = np.full(n_states, _NEG)
    alpha[0] = lp[0, blank]
    alpha[1] = lp[0, ext[1]]
    back = np.zeros((n_frames, n_states), dtype=np.int8)

    prev1 = np.empty(n_states)
    prev2 = np.empty(n_states)
    for t in range(1, n_frames):
        prev1[0] = _NEG
        prev1[1:] = alpha[:-1]
        prev2[:2] = _NEG
        prev2[2:] = alpha[:-2]
        prev2[~can_skip] = _NEG

        best = alpha
        step = np.zeros(n_states, dtype=np.int8)
        take1 = prev1 > best
        best = np.where(take1, prev1, best)
        step[take1] = 1
        take2 = prev2 > best
        best = np.where(take2, prev2, best)
        step[take2] = 2

        alpha = best + lp[t, ext]
        back[t] = step

    state = n_states - 1 if alpha[n_states - 1] >= alpha[n_states - 2] else n_states - 2
    path = np.empty(n_frames, dtype=np.int64)
    for t in range(n_frames - 1, -1, -1):
        path[t] = state
        state -= int(back[t, state])

    spans = []
    t = 0
    while t < n_frames:
        s = int(path[t])
        e = t
        while e + 1 < n_frames and path[e + 1] == s:
            e += 1
        if s % 2 == 1:
            token = targets[(s - 1) // 2]
            score = float(np.exp(lp[t : e + 1, token]).mean())
            spans.append(Span(t, e + 1, score))
        t = e + 1
    return spans


# ── Timeline ──────────────────────────────────────────────────────────────────


def _r(x: float) -> float:
    return round(float(x), 3)


def build_timeline(lines: list, tokens: Tokens, spans: list, frame_seconds: float):
    """Fold per-letter spans into words and lines.

    Words with no letters the model can pronounce cannot be aligned; they are
    parked where they sit between their neighbours so the text stays complete.
    Returns (lines, aligned_word_count).
    """
    by_word = {}
    for span, word in zip(spans, tokens.word_of):
        by_word.setdefault(word, []).append(span)

    flat = [w for line in lines for w in line]
    times = []  # (start, end, score, aligned) per word
    for w in range(len(flat)):
        group = by_word.get(w)
        if group:
            times.append([
                group[0].start * frame_seconds,
                group[-1].end * frame_seconds,
                sum(s.score for s in group) / len(group),
                True,
            ])
        else:
            times.append(None)

    last_end = None
    for i, entry in enumerate(times):
        if entry is not None:
            last_end = entry[1]
            continue
        nxt = next((e for e in times[i + 1 :] if e is not None), None)
        at = last_end if last_end is not None else (nxt[0] if nxt is not None else 0.0)
        times[i] = [at, at, 0.0, False]

    out_lines = []
    word = 0
    for line in lines:
        words = []
        for raw in line:
            start, end, score, _ = times[word]
            words.append({"text": raw, "start": _r(start), "end": _r(max(end, start)), "score": _r(score)})
            word += 1
        scores = [w["score"] for w in words if w["score"] > 0]
        out_lines.append({
            "text": " ".join(line),
            "start": words[0]["start"],
            "end": words[-1]["end"],
            "score": _r(sum(scores) / len(scores)) if scores else 0.0,
            "words": words,
        })
    return out_lines, sum(1 for t in times if t[3])


# ── Acoustic models ───────────────────────────────────────────────────────────

# Output classes of torchaudio's WAV2VEC2_ASR_BASE_960H; index 0 is the CTC blank.
_W2V2_LABELS = ("-", "|", "E", "T", "A", "O", "N", "I", "H", "S", "R", "D", "L", "U", "M", "W", "C", "F",
                "G", "Y", "P", "B", "V", "K", "'", "X", "J", "Q", "Z")
_W2V2_CHAR_IDS = {label.lower(): i for i, label in enumerate(_W2V2_LABELS) if len(label) == 1 and (label.isalpha() or label == "'")}
_W2V2_BUNDLE = "WAV2VEC2_ASR_BASE_960H"
_W2V2_URL = "https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth"
_W2V2_BYTES = 377664473

_STRIDE = 320  # samples per output frame at 16 kHz
_RECEPTIVE = 400


def download_file(url: str, dest: str, on_progress=None, opener=urllib.request.urlopen):
    """Fetch `url` to `dest` atomically; a partial download never lands at `dest`."""
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        return
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    part = dest + ".part"
    try:
        with opener(urllib.request.Request(url, headers={"User-Agent": USER_AGENT}), timeout=60) as resp:
            total = int(resp.headers.get("Content-Length") or 0)
            got = 0
            with open(part, "wb") as out:
                while True:
                    block = resp.read(1 << 20)
                    if not block:
                        break
                    out.write(block)
                    got += len(block)
                    if on_progress and total:
                        on_progress(min(got / total, 1.0))
        if total and got != total:
            raise LyricsError(f"The model download was incomplete ({got} of {total} bytes). Please try again.")
        os.replace(part, dest)
    except LyricsError:
        _discard(part)
        raise
    except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError) as e:
        _discard(part)
        raise LyricsError(f"Could not download the lyrics model: {e}") from e


def _discard(path: str):
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except OSError as e:
        _log(f"could not remove {path}: {e}")


def chunked_emissions(audio: np.ndarray, forward, chunk_s: float = 20.0, context_s: float = 2.0,
                      sample_rate: int = 16000, on_progress=None) -> np.ndarray:
    """Run `forward(chunk) -> (frames, classes)` over long audio in overlapping
    windows and stitch the centres back together.

    A transformer's attention cost grows with the square of the input length, so
    a whole song in one call does not fit in memory. Each window is padded with
    `context_s` either side for context that is then cropped away.
    """
    chunk = int(chunk_s * sample_rate)
    ctx = int(context_s * sample_rate)
    if chunk % _STRIDE or ctx % _STRIDE:
        raise ValueError("chunk and context must be whole numbers of model frames")
    if len(audio) < _RECEPTIVE:
        raise LyricsError("The vocals track is too short to align.")

    pieces = []
    starts = list(range(0, len(audio), chunk))
    for i, s in enumerate(starts):
        a = max(0, s - ctx)
        b = min(len(audio), s + chunk + ctx)
        frames = np.asarray(forward(audio[a:b]))
        lead = (s - a) // _STRIDE
        last = s + chunk >= len(audio)
        keep = frames.shape[0] - lead if last else chunk // _STRIDE
        pieces.append(frames[lead : lead + keep])
        if on_progress:
            on_progress((i + 1) / len(starts))
    return np.concatenate(pieces, axis=0)


class Wav2Vec2Aligner:
    """English wav2vec2-base-960h (torchaudio), downloaded on first use."""

    name = "wav2vec2-base-960h"
    sample_rate = 16000
    frame_seconds = _STRIDE / 16000
    blank_id = 0
    char_ids = _W2V2_CHAR_IDS

    def __init__(self, models_dir: str | None = None):
        self.models_dir = models_dir or os.path.join(os.path.expanduser("~"), ".songpracticestudio", "models")
        self._model = None
        self._torch = None

    def _load(self, on_progress):
        if self._model is not None:
            return
        try:
            import torch
            import torchaudio
        except ImportError as e:
            raise LyricsError(f"Lyrics sync needs the sidecar's torch install, which is missing: {e}") from e

        bundle = getattr(torchaudio.pipelines, _W2V2_BUNDLE)
        if tuple(bundle.get_labels()) != _W2V2_LABELS:
            raise LyricsError("The lyrics model's alphabet is not the one this build expects.")

        dest = os.path.join(self.models_dir, os.path.basename(_W2V2_URL))
        if not (os.path.isfile(dest) and os.path.getsize(dest) > 0) and on_progress:
            on_progress(0.0, f"Downloading the lyrics model (one time, ~{_W2V2_BYTES // 1_000_000} MB)")
        download_file(_W2V2_URL, dest, (lambda f: on_progress(0.4 * f, f"Downloading the lyrics model ({int(f * 100)}%)")) if on_progress else None)

        try:
            model = bundle.get_model(dl_kwargs={"model_dir": self.models_dir, "progress": False})
        except (RuntimeError, EOFError, ValueError, pickle.UnpicklingError) as e:
            _discard(dest)
            raise LyricsError(
                "The lyrics model file was damaged and has been removed. Sync again to download it afresh."
            ) from e
        model.eval()
        self._model = model
        self._torch = torch

    def _forward(self, chunk: np.ndarray) -> np.ndarray:
        torch = self._torch
        with torch.inference_mode():
            out, _ = self._model(torch.from_numpy(np.ascontiguousarray(chunk, dtype=np.float32))[None])
            return torch.log_softmax(out, dim=-1)[0].numpy()

    def emissions(self, audio: np.ndarray, targets, on_progress=None) -> np.ndarray:
        self._load(on_progress)
        report = (lambda f: on_progress(0.4 + 0.6 * f, "Listening to the vocals")) if on_progress else None
        return chunked_emissions(audio, self._forward, sample_rate=self.sample_rate, on_progress=report)


class UniformAligner:
    """TEST ONLY (`SPS_LYRICS_ENGINE=uniform`): spreads the letters evenly across
    the part of the file that is not silent. No model, no network. It exists so
    the Rust <-> Python wire path can be exercised in CI; it is never a fallback.
    """

    name = "uniform-test-engine"
    sample_rate = 16000
    frame_seconds = _STRIDE / 16000
    blank_id = 0
    char_ids = _W2V2_CHAR_IDS

    def emissions(self, audio, targets, on_progress=None):
        n_frames = max(len(audio) // _STRIDE, len(targets) * 2 + 2)
        probs = np.full((n_frames, len(_W2V2_LABELS)), 0.01)
        probs[:, 0] = 0.9
        loud = np.flatnonzero(np.abs(audio) > 1e-3)
        lo = int(loud[0]) // _STRIDE if loud.size else 0
        hi = int(loud[-1]) // _STRIDE if loud.size else n_frames - 1
        hi = max(hi, lo + len(targets) * 2)
        hi = min(hi, n_frames - 1)
        for i, token in enumerate(targets):
            frame = lo + int((i + 0.5) * (hi - lo) / max(len(targets), 1))
            frame = min(max(frame, 0), n_frames - 1)
            probs[frame, :] = 0.01
            probs[frame, token] = 0.9
        if on_progress:
            on_progress(1.0, "Listening to the vocals")
        return np.log(probs / probs.sum(axis=1, keepdims=True))


def default_aligner(models_dir: str | None = None):
    if os.environ.get("SPS_LYRICS_ENGINE") == "uniform":
        return UniformAligner()
    return Wav2Vec2Aligner(models_dir)


# ── Orchestration ─────────────────────────────────────────────────────────────


class _Progress:
    """Forwards progress without ever going backwards."""

    def __init__(self, callback):
        self._callback = callback
        self._last = 0.0

    def __call__(self, value: float, stage: str):
        if self._callback is None:
            return
        value = min(max(value, self._last), 1.0)
        self._last = value
        self._callback(value, stage)


def _load_mono(path: str, sample_rate: int) -> np.ndarray:
    import soundfile as sf

    try:
        audio, sr = sf.read(path, dtype="float32", always_2d=True)
    except (RuntimeError, OSError) as e:
        raise LyricsError(f"Could not read the vocals file: {e}") from e
    audio = audio.mean(axis=1)
    if sr != sample_rate:
        from math import gcd

        from scipy.signal import resample_poly

        g = gcd(sr, sample_rate)
        audio = resample_poly(audio, sample_rate // g, sr // g).astype(np.float32)
    return np.ascontiguousarray(audio, dtype=np.float32)


def assess_alignment(mean_score: float, evidence_ratio: float, aligned: int, total: int):
    """A user-facing hint when the text probably does not fit the recording, else None.

    Heuristic and deliberately conservative: it cannot detect the text of a
    different song, only gross mismatches and missing or surplus sections.
    """
    if evidence_ratio > MAX_EVIDENCE_RATIO:
        return (
            "The recording contains much more singing than these lyrics. The text may be "
            "incomplete - write out every repeated chorus and verse in full."
        )
    if evidence_ratio < MIN_EVIDENCE_RATIO:
        return (
            "These lyrics are much longer than what is sung. Remove sections that are not in "
            "this recording."
        )
    if mean_score < LOW_CONFIDENCE_SCORE or aligned < LOW_COVERAGE_RATIO * total:
        return "The lyrics do not match the recording well. Check that the text is for this song."
    return None


def align_lyrics(vocals_path: str, text: str, aligner=None, on_progress=None, models_dir: str | None = None) -> dict:
    progress = _Progress(on_progress)
    if not os.path.isfile(vocals_path):
        raise LyricsError(f"Vocals file not found: {vocals_path}")

    lines = parse_lyrics(text)
    if not lines:
        raise LyricsError("The lyrics contain no words to align.")

    aligner = aligner or default_aligner(models_dir)
    tokens = tokenize(lines, aligner.char_ids)
    if not tokens.ids:
        raise LyricsError("The lyrics contain no letters the model can recognise (numbers and symbols alone cannot be aligned).")

    progress(0.02, "Preparing the vocals")
    audio = _load_mono(vocals_path, aligner.sample_rate)
    if audio.size == 0 or float(np.max(np.abs(audio))) < 1e-4:
        raise LyricsError("The vocals track is silent - there is no singing to align the lyrics to.")

    log_probs = aligner.emissions(audio, tokens.ids, on_progress=lambda v, s: progress(0.05 + 0.85 * v, s))

    progress(0.92, "Aligning the lyrics")
    spans = ctc_forced_align(log_probs, tokens.ids, aligner.blank_id)
    out_lines, aligned = build_timeline(lines, tokens, spans, aligner.frame_seconds)

    scores = [w["score"] for line in out_lines for w in line["words"] if w["score"] > 0]
    mean_score = sum(scores) / len(scores) if scores else 0.0
    heard = float(np.sum(1.0 - np.exp(log_probs[:, aligner.blank_id])))
    evidence_ratio = heard / len(tokens.ids)
    warning = assess_alignment(mean_score, evidence_ratio, aligned, tokens.n_words)

    progress(1.0, "Done")
    return {
        "aligner": aligner.name,
        "lines": out_lines,
        "meanScore": _r(mean_score),
        "evidenceRatio": _r(evidence_ratio),
        "alignedWords": aligned,
        "totalWords": tokens.n_words,
        "warning": warning,
    }


# ── Finding lyrics online (LRCLIB) ────────────────────────────────────────────

_NOISE_WORDS = re.compile(
    r"\b(hd|hq|4k|8k|lyrics?|official|video|audio|remaster(?:ed)?|full\s+song|visuali[sz]er|mv|"
    r"music\s+video|lyric\s+video)\b",
    re.IGNORECASE,
)
_BRACKET_GROUP = re.compile(r"\s*[\(\[][^\)\]]*[\)\]]")
_TIMESTAMP_TAGS = re.compile(r"\[\d+:\d+(?:[.:]\d+)?\]|<\d+:\d+(?:[.:]\d+)?>")
_LRC_META = re.compile(r"^\s*\[[A-Za-z]+:[^\]]*\]\s*$")


def clean_title(title: str) -> str:
    """Drop the decoration a video title carries ('(Official Video)', '[HQ]', 'lyrics')."""
    original = " ".join(title.split())

    def drop_noisy_group(m):
        return " " if _NOISE_WORDS.search(m.group(0)) else m.group(0)

    cleaned = _BRACKET_GROUP.sub(drop_noisy_group, original)
    cleaned = re.sub(r"\blyrics?\b", " ", cleaned, flags=re.IGNORECASE)
    cleaned = " ".join(cleaned.split()).strip(" -")
    return cleaned or original


def strip_timestamps(synced: str) -> str:
    out = []
    for line in synced.splitlines():
        if _LRC_META.match(line):
            continue
        line = _TIMESTAMP_TAGS.sub("", line).strip()
        if line:
            out.append(line)
    return "\n".join(out)


def _name_tokens(s: str) -> set:
    return set(re.findall(r"[a-z0-9]+", s.lower()))


def pick_best(candidates: list, duration, title: str):
    """The LRCLIB result most likely to be this recording, or None."""
    want = _name_tokens(title)
    best = None
    for index, c in enumerate(candidates):
        if not isinstance(c, dict) or c.get("instrumental"):
            continue
        has_synced = bool((c.get("syncedLyrics") or "").strip())
        if not (has_synced or (c.get("plainLyrics") or "").strip()):
            continue

        try:
            cand_duration = float(c["duration"]) if c.get("duration") is not None else None
        except (TypeError, ValueError):
            cand_duration = None
        if duration is None:
            delta = 0.0
        elif cand_duration is None:
            delta = UNKNOWN_DURATION_PENALTY_S
        else:
            delta = abs(cand_duration - float(duration))
            if delta > MAX_DURATION_DELTA_S:
                continue

        name = _name_tokens(c.get("trackName") or "")
        overlap = len(name & want) / len(name) if name else 0.5
        score = delta + (0.0 if has_synced else 2.0) + 5.0 * (1.0 - overlap)
        if best is None or score < best[0]:
            best = (score, index, c)
    return best[2] if best else None


def _fetch_json(url: str):
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def find_lyrics(title: str, artist: str | None = None, duration: float | None = None, fetch=None) -> dict:
    query = clean_title(title)
    if artist and artist.lower() not in query.lower():
        query = f"{artist} {query}"
    url = LRCLIB_SEARCH_URL + "?" + urllib.parse.urlencode({"q": query})
    try:
        data = (fetch or _fetch_json)(url)
    except json.JSONDecodeError as e:
        raise LyricsError("The lyrics service returned an unexpected reply.") from e
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise LyricsError(f"Could not reach the lyrics service: {e}") from e
    if not isinstance(data, list):
        raise LyricsError("The lyrics service returned an unexpected reply.")

    best = pick_best(data, duration, query)
    if best is None:
        raise LyricsError(f"No lyrics found for \"{query}\".")

    synced = (best.get("syncedLyrics") or "").strip()
    text = strip_timestamps(synced) if synced else (best.get("plainLyrics") or "").strip()
    return {
        "text": text,
        "synced": bool(synced),
        "title": best.get("trackName") or "",
        "artist": best.get("artistName") or "",
        "duration": best.get("duration"),
        "source": "lrclib",
    }
