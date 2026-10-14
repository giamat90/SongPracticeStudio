"""
Tab sync: place the bar lines of a Guitar Pro tab on a song's timeline.

The app reads the tab with alphaTab and sends a compact score (played bars,
tempo map, pitched and drum notes). `align_tab_to_stems` returns the time in the
recording at which each played bar starts, plus how much to trust it.

The algorithm is one function behind one signature, so it can be replaced
without touching the protocol, storage or UI:

    chroma-dtw-v1
      1. features: pitch-class energy of the tab's guitar/bass/keys notes against
         the guitar/bass/piano/other stems, stacked with kick and snare onset
         channels (tab drum track against the drum stem band onsets)
      2. global offset search at the tab's nominal tempo, repeated for -2..+2
         semitones (tabs are often tuned a semitone down)
      3. DTW restricted to a band around that offset
"""
import json
import os
from typing import Callable, Optional

import numpy as np

ALGORITHM = "chroma-dtw-v1"
SCORE_VERSION = 1
RESULT_VERSION = 1

SAMPLE_RATE = 22050
HOP = 1024
FPS = SAMPLE_RATE / HOP

HARMONY_STEMS = ("guitar", "bass", "piano", "other")

PITCHED_ROLES = {"g", "b", "k"}
KICK_NOTES = {35, 36}
SNARE_NOTES = {37, 38, 39, 40}

DRUM_WEIGHT = 4.0
ONSET_SIGMA_FRAMES = 1.5
FEATURE_FLOOR = 1e-3

MAX_LAG_BEFORE_SECONDS = 5.0
MAX_LAG_AFTER_SECONDS = 45.0
MIN_OVERLAP = 0.5
BAND_SECONDS = 8.0
START_WINDOW_SECONDS = 0.3
TRANSPOSE_RANGE = 2
TRANSPOSE_PENALTY = 0.02
OFF_DIAGONAL_PENALTY = 0.6

GOOD_COST = 0.36
CHECK_COST = 0.45
MIN_PEAK = 0.45
STEADY_RATIO = 0.20
STEADY_SHARE = 0.70

MAX_NOTES = 400_000
MAX_BARS = 5_000


class TabSyncError(ValueError):
    """The tab or the song cannot be aligned; the message is shown to the user."""


Progress = Callable[[float, str], None]


def validate_score(score: dict) -> None:
    if not isinstance(score, dict) or score.get("version") != SCORE_VERSION:
        raise TabSyncError("Unsupported tab data")
    division = score.get("division")
    if not isinstance(division, int) or division <= 0:
        raise TabSyncError("Tab has no time resolution")
    tempos = score.get("tempos")
    if not tempos or any(len(t) != 2 or t[1] <= 0 for t in tempos):
        raise TabSyncError("Tab has no tempo")
    bars = score.get("bars")
    if not bars:
        raise TabSyncError("Tab has no bars")
    if len(bars) > MAX_BARS:
        raise TabSyncError("Tab has too many bars")
    for b in bars:
        if not {"tick", "end", "index", "occurrence"} <= set(b) or b["end"] <= b["tick"]:
            raise TabSyncError("Tab has a malformed bar")
    notes = score.get("notes")
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        raise TabSyncError("Tab has too many notes" if isinstance(notes, list) else "Tab has no notes")
    if not any(n[3] in PITCHED_ROLES for n in notes):
        raise TabSyncError("Tab has no guitar, bass or keyboard notes to follow")


def _tick_seconds(score: dict) -> Callable[[np.ndarray], np.ndarray]:
    """Piecewise-linear tick -> seconds from the tab's tempo map."""
    div = float(score["division"])
    tempos = sorted((int(t), float(b)) for t, b in score["tempos"])
    if tempos[0][0] > 0:
        tempos.insert(0, (0, tempos[0][1]))
    ticks = np.array([t for t, _ in tempos], dtype=np.float64)
    spq = np.array([60.0 / b for _, b in tempos], dtype=np.float64)
    secs = np.concatenate([[0.0], np.cumsum(np.diff(ticks) / div * spq[:-1])])

    def to_seconds(t) -> np.ndarray:
        t = np.asarray(t, dtype=np.float64)
        k = np.clip(np.searchsorted(ticks, t, side="right") - 1, 0, len(ticks) - 1)
        return secs[k] + (t - ticks[k]) / div * spq[k]

    return to_seconds


def _smooth(env: np.ndarray, sigma: float = ONSET_SIGMA_FRAMES) -> np.ndarray:
    from scipy.ndimage import gaussian_filter1d
    return gaussian_filter1d(env.astype(np.float32), sigma)


def _normalize(x: np.ndarray) -> np.ndarray:
    x = x + FEATURE_FLOOR
    return (x / np.linalg.norm(x, axis=0, keepdims=True)).astype(np.float32)


def score_features(score: dict, n_frames: int) -> tuple:
    """(12 x n chroma, kick envelope, snare envelope) of the tab on its own nominal timeline."""
    to_sec = _tick_seconds(score)
    notes = score["notes"]
    chroma = np.zeros((12, n_frames), np.float32)
    kick = np.zeros(n_frames, np.float32)
    snare = np.zeros(n_frames, np.float32)
    if notes:
        ticks = np.array([n[0] for n in notes], dtype=np.float64)
        durs = np.array([max(n[1], 1) for n in notes], dtype=np.float64)
        start = to_sec(ticks) * FPS
        end = to_sec(ticks + durs) * FPS
        for (_, _, pitch, role), a, b in zip(notes, start, end):
            fa = int(a)
            if fa < 0 or fa >= n_frames:
                continue
            if role in PITCHED_ROLES:
                chroma[int(pitch) % 12, fa:min(max(int(b), fa + 1), n_frames)] += 1.0
            elif role == "d":
                if pitch in KICK_NOTES:
                    kick[fa] += 1.0
                elif pitch in SNARE_NOTES:
                    snare[fa] += 1.0
    return chroma, _smooth(kick), _smooth(snare)


def _load_mono(path: str) -> np.ndarray:
    import librosa
    y, _ = librosa.load(path, sr=SAMPLE_RATE, mono=True)
    return y


def audio_features(stem_paths: dict) -> tuple:
    """(12 x m chroma of the harmonic stems, kick envelope or None, snare envelope or None)."""
    import librosa
    harmony = [stem_paths[s] for s in HARMONY_STEMS if s in stem_paths and os.path.isfile(stem_paths[s])]
    if not harmony:
        raise TabSyncError("The song has no guitar, bass, piano or other stem to compare the tab with")
    mix = None
    for p in harmony:
        y = _load_mono(p)
        if mix is None:
            mix = y
        else:
            n = min(len(mix), len(y))
            mix = mix[:n] + y[:n]
    if mix is None or len(mix) == 0 or float(np.max(np.abs(mix))) < 1e-6:
        raise TabSyncError("The song's stems are silent")
    chroma = librosa.feature.chroma_cqt(y=mix, sr=SAMPLE_RATE, hop_length=HOP)
    kick = snare = None
    drums = stem_paths.get("drums")
    if drums and os.path.isfile(drums):
        d = _load_mono(drums)
        mel = librosa.feature.melspectrogram(y=d, sr=SAMPLE_RATE, n_fft=2048, hop_length=HOP, n_mels=64, fmax=8000)
        db = librosa.power_to_db(mel + 1e-10)
        envs = []
        for lo, hi in ((0, 6), (10, 34)):
            on = librosa.onset.onset_strength(S=db[lo:hi], sr=SAMPLE_RATE, hop_length=HOP)
            on = on / (np.percentile(on, 99) + 1e-9)
            envs.append(_smooth(np.clip(on, 0, 1.5)))
        kick, snare = envs
    return chroma, kick, snare


def _stack(chroma: np.ndarray, kick, snare, weight: float) -> np.ndarray:
    rows = [chroma]
    if weight:
        n = chroma.shape[1]
        for env in (kick, snare):
            e = np.zeros(n, np.float32)
            k = min(n, len(env))
            e[:k] = env[:k]
            rows.append(weight * e[None, :])
    return _normalize(np.vstack(rows))


def best_offset(S: np.ndarray, A: np.ndarray) -> tuple:
    """Lag (frames; audio frame = score frame + lag) with the best mean cosine, that cosine, and the median over all lags."""
    from scipy.signal import correlate
    n, m = S.shape[1], A.shape[1]
    lo = -int(MAX_LAG_BEFORE_SECONDS * FPS)
    hi = int(MAX_LAG_AFTER_SECONDS * FPS)
    lags = np.arange(lo, hi + 1)
    total = np.zeros(n + m - 1, np.float64)
    for r in range(S.shape[0]):
        total += correlate(A[r].astype(np.float64), S[r].astype(np.float64), mode="full", method="fft")
    idx = lags + (n - 1)
    ok = (idx >= 0) & (idx < len(total))
    overlap = np.minimum(n, m - lags) - np.maximum(0, -lags)
    ok &= overlap >= MIN_OVERLAP * n
    if not np.any(ok):
        raise TabSyncError("The tab and the recording do not overlap")
    score = np.full(len(lags), -1.0)
    score[ok] = total[idx[ok]] / overlap[ok]
    k = int(np.argmax(score))
    return int(lags[k]), float(score[k]), float(np.median(score[ok]))


def banded_dtw(S: np.ndarray, A: np.ndarray, lag: int, radius: int) -> tuple:
    """
    DTW of the score S (d x n) against A (d x m) inside +-radius frames of the line
    j = i + lag. Steps (1,1), (1,2), (2,1): slopes between 0.5 and 2, every cell
    depends only on the two previous rows, so a row is one vectorised operation and
    the memory is n x (2*radius+1), not n x m.

    Returns (j, mean_cost): the matched audio frame for every score frame (float,
    interpolated over skipped rows) and the mean frame distance along the path.
    """
    n, m = S.shape[1], A.shape[1]
    width = 2 * radius + 1
    offs = np.arange(-radius, radius + 1)
    pad = np.full((A.shape[0], 1), 1.0 / np.sqrt(A.shape[0]), np.float32)
    Ap = np.concatenate([A, pad], axis=1)
    cost = np.empty((n, width), np.float32)
    chunk = 256
    for a in range(0, n, chunk):
        b = min(n, a + chunk)
        j = (np.arange(a, b)[:, None] + lag + offs[None, :])
        valid = (j >= 0) & (j < m)
        j = np.where(valid, j, m)
        c = 1.0 - np.einsum("dn,dnw->nw", S[:, a:b], Ap[:, j], optimize=True)
        c[~valid] = 3.0
        cost[a:b] = c
    inf = np.float32(np.inf)
    D = np.full((n, width), inf, np.float32)
    step = np.zeros((n, width), np.int8)
    start = np.abs(offs) <= int(START_WINDOW_SECONDS * FPS)
    D[0] = np.where(start, cost[0], inf)
    if n > 1:
        diag = D[0]
        left = np.concatenate([[inf], D[0][:-1]]) + OFF_DIAGONAL_PENALTY
        pick = left < diag
        D[1] = cost[1] + np.where(pick, left, diag)
        step[1] = pick.astype(np.int8)
    for i in range(2, n):
        diag = D[i - 1]
        left = np.empty(width, np.float32)
        left[0] = inf
        left[1:] = D[i - 1][:-1]
        left += OFF_DIAGONAL_PENALTY
        skip = np.empty(width, np.float32)
        skip[-1] = inf
        skip[:-1] = D[i - 2][1:]
        skip += OFF_DIAGONAL_PENALTY
        stacked = np.stack([diag, left, skip])
        which = np.argmin(stacked, axis=0)
        D[i] = cost[i] + stacked[which, np.arange(width)]
        step[i] = which
    d = int(np.argmin(D[n - 1]))
    if not np.isfinite(D[n - 1, d]):
        raise TabSyncError("The tab could not be fitted to the recording")
    jmap = np.full(n, np.nan, np.float64)
    path_cost = 0.0
    counted = 0
    i = n - 1
    while i >= 0:
        jmap[i] = i + lag + (d - radius)
        c = float(cost[i, d])
        if c < 2.5:
            path_cost += c
            counted += 1
        s = int(step[i, d]) if i > 0 else 0
        if i == 0:
            break
        if s == 0:
            i -= 1
        elif s == 1:
            i -= 1
            d -= 1
        else:
            i -= 2
            d += 1
    ok = ~np.isnan(jmap)
    jmap = np.interp(np.arange(n), np.where(ok)[0], jmap[ok])
    return jmap, (path_cost / counted if counted else 1.0)


def _quality(peak: float, mean_cost: float, steadiness: float) -> str:
    """
    Thresholds come from 12 real tabs (good: cost 0.21-0.35) and the known-bad
    cases (a shortened video 0.43, a bass cover 0.39, noise 0.62). The cost is
    taken after warping, so a drifting performance is not penalised; the offset
    peak is not, which is why it only sets a floor.
    """
    level = 2 if mean_cost <= GOOD_COST else 1 if mean_cost <= CHECK_COST else 0
    if peak < MIN_PEAK:
        level = 0
    if steadiness < STEADY_SHARE:
        level = max(0, level - 1)
    return ("poor", "check", "good")[level]


def align_tab_to_stems(score: dict, stem_paths: dict, on_progress: Optional[Progress] = None) -> dict:
    """
    Place every played bar of the tab on the recording.

    Returns {"algorithm", "version", "offset", "transpose", "usedDrums", "peak",
    "baseline", "meanCost", "steadiness", "quality", "bars": [{"index",
    "occurrence", "time"}]}; times are seconds in the recording and never decrease.
    """
    def tell(v: float, stage: str):
        if on_progress:
            on_progress(v, stage)

    validate_score(score)
    to_sec = _tick_seconds(score)
    bars = score["bars"]
    bar_ticks = np.array([b["tick"] for b in bars], dtype=np.float64)
    bar_secs = to_sec(bar_ticks)
    end_sec = float(to_sec(np.array([max(b["end"] for b in bars)]))[0])
    n_frames = int(end_sec * FPS) + 2

    tell(0.02, "tab-features")
    s_chroma, s_kick, s_snare = score_features(score, n_frames)
    if float(s_chroma.sum()) <= 0:
        raise TabSyncError("The tab has no notes inside its bars")

    tell(0.10, "audio-features")
    a_chroma, a_kick, a_snare = audio_features(stem_paths)
    used_drums = a_kick is not None and bool(s_kick.sum() + s_snare.sum() > 0)
    weight = DRUM_WEIGHT if used_drums else 0.0
    A = _stack(a_chroma, a_kick, a_snare, weight)

    tell(0.55, "offset")
    best = None
    for shift in range(-TRANSPOSE_RANGE, TRANSPOSE_RANGE + 1):
        S = _stack(np.roll(s_chroma, shift, axis=0), s_kick, s_snare, weight)
        lag, peak, base = best_offset(S, A)
        adjusted = peak - TRANSPOSE_PENALTY * abs(shift)
        if best is None or adjusted > best[0]:
            best = (adjusted, shift, lag, peak, base, S)
    _, shift, lag, peak, base, S = best

    tell(0.75, "alignment")
    radius = int(BAND_SECONDS * FPS)
    jmap, mean_cost = banded_dtw(S, A, lag, radius)

    bar_frames = np.clip(bar_secs * FPS, 0, n_frames - 1)
    est = np.interp(bar_frames, np.arange(len(jmap)), jmap) / FPS
    est = np.maximum.accumulate(est)
    est = np.maximum(est, 0.0)

    nominal = np.diff(bar_secs)
    actual = np.diff(est)
    keep = nominal > 1e-6
    if np.any(keep):
        ratio = actual[keep] / nominal[keep]
        med = float(np.median(ratio))
        steadiness = float(np.mean(np.abs(ratio / med - 1.0) < STEADY_RATIO)) if med > 1e-6 else 0.0
    else:
        steadiness = 0.0

    tell(1.0, "done")
    return {
        "version": RESULT_VERSION,
        "algorithm": ALGORITHM,
        "offset": float(lag / FPS),
        "transpose": int(shift),
        "usedDrums": bool(used_drums),
        "peak": round(float(peak), 4),
        "baseline": round(float(base), 4),
        "meanCost": round(float(mean_cost), 4),
        "steadiness": round(steadiness, 4),
        "quality": _quality(float(peak), float(mean_cost), steadiness),
        "bars": [
            {"index": int(b["index"]), "occurrence": int(b["occurrence"]), "time": round(float(t), 3)}
            for b, t in zip(bars, est)
        ],
    }


def align_tab_file(score_path: str, stem_paths: dict, output_path: str, on_progress: Optional[Progress] = None) -> dict:
    """Read the score JSON the app wrote, align it and write the result JSON atomically."""
    with open(score_path, "r", encoding="utf-8") as f:
        score = json.load(f)
    result = align_tab_to_stems(score, stem_paths, on_progress)
    tmp = output_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(result, f)
    os.replace(tmp, output_path)
    return {k: result[k] for k in ("offset", "transpose", "quality", "peak", "steadiness")} | {"bars": len(result["bars"])}
