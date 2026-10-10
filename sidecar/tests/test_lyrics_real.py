"""Alignment on real, Demucs-separated vocals against an independent reference.

Local-only: it needs the user's own library (`~/.songpracticestudio`), the cached wav2vec2
weights and network access to LRCLIB, and skips itself when any is missing, so CI
never runs it. Lyrics are fetched at test time and cached under `tests/_local/`
(git-ignored); no copyrighted text is ever committed.

Two oracles, because neither alone is trustworthy:
  * LRCLIB's community timestamps - noisy (often 1-2 s late, sometimes for a
    different edit), so a constant offset is removed before comparing;
  * the vocal stem's own energy - a line must start where someone is singing.
"""

import json
import os
import re
import urllib.parse

import numpy as np
import pytest
import soundfile as sf

import lyrics

pytestmark = pytest.mark.slow

REAL_HOME = os.path.expanduser("~")  # captured before the autouse fixture redirects HOME
LIBRARY = os.path.join(REAL_HOME, ".songpracticestudio", "library.json")
LOCAL_CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_local")
WEIGHTS = os.path.basename(lyrics._W2V2_URL)

# (library title fragment, minimum share of lines within 2 s of LRCLIB after the
#  constant offset is removed, minimum share of line starts that sit on singing).
# Floors sit a little under what was measured on 2026-10-10 (see wiki/lyrics.md).
# "Start A Fire" is deliberately absent: LRCLIB's only match is a different
# recording (187.8 s vs 192.1 s here), so the reference, not the aligner, is wrong.
SONGS = [
    ("Like a stone", 0.90, 0.95),
    ("Rolling in the Deep", 0.90, 0.95),
    ("Smooth Criminal", 0.75, 0.95),
    ("Beat It", 0.85, 0.90),
    ("Immigrant Song", 0.90, 0.95),
    ("War Pigs", 0.90, 0.95),
    ("Mercy", 0.90, 0.95),
    ("Muse - Starlight", 0.90, 0.95),
    ("Firework", 0.90, 0.95),
    ("Party In The U.S.A.", 0.85, 0.95),
    ("What I've Done", 0.85, 0.95),
]


def _models_dir():
    candidates = [
        os.environ.get("SPS_LYRICS_MODELS_DIR"),
        os.path.join(REAL_HOME, ".songpracticestudio", "models"),
        os.path.join(REAL_HOME, ".cache", "torch", "hub", "checkpoints"),
    ]
    for d in candidates:
        if d and os.path.isfile(os.path.join(d, WEIGHTS)):
            return d
    return None


def _library():
    if not os.path.isfile(LIBRARY):
        return []
    data = json.load(open(LIBRARY, encoding="utf-8"))
    return data["songs"] if isinstance(data, dict) else data


def _song(fragment):
    for s in _library():
        if fragment.lower() in s["title"].lower() and os.path.isfile(os.path.join(s["directory"], "vocals.wav")):
            return s
    return None


def _reference(song):
    os.makedirs(LOCAL_CACHE, exist_ok=True)
    cache = os.path.join(LOCAL_CACHE, song["id"][:8] + ".json")
    if os.path.isfile(cache):
        return json.load(open(cache, encoding="utf-8"))
    query = lyrics.clean_title(song["title"])
    try:
        found = lyrics._fetch_json(lyrics.LRCLIB_SEARCH_URL + "?" + urllib.parse.urlencode({"q": query}))
    except Exception as e:  # network down: nothing to compare against
        pytest.skip(f"LRCLIB unreachable: {e}")
    close = [c for c in found if c.get("syncedLyrics") and c.get("duration") is not None
             and abs(c["duration"] - song["duration"]) <= 6]
    close.sort(key=lambda c: abs(c["duration"] - song["duration"]))
    if not close:
        pytest.skip(f"no synced reference for {song['title']}")
    json.dump(close[0], open(cache, "w", encoding="utf-8"))
    return close[0]


def _timed_lines(synced):
    out = []
    for line in synced.splitlines():
        m = re.match(r"\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)", line)
        if m and m.group(3).strip():
            out.append((int(m.group(1)) * 60 + float(m.group(2)), m.group(3)))
    return out


def _share_on_singing(vocals, starts, floor_db=-45.0, window=0.6):
    y, sr = sf.read(vocals, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    hits = 0
    for s in starts:
        seg = y[int(s * sr) : int((s + window) * sr)]
        if len(seg) and 20 * np.log10(np.sqrt(np.mean(seg**2)) + 1e-9) > floor_db:
            hits += 1
    return hits / len(starts)


@pytest.fixture(scope="module")
def aligner():
    models = _models_dir()
    if models is None and not os.environ.get("SPS_LYRICS_ALLOW_DOWNLOAD"):
        pytest.skip("lyrics model weights are not cached (set SPS_LYRICS_ALLOW_DOWNLOAD=1 to fetch them)")
    pytest.importorskip("torch")
    pytest.importorskip("torchaudio")
    return lyrics.Wav2Vec2Aligner(models)


def _check(aligner, fragment, min_timing, min_energy):
    song = _song(fragment)
    if song is None:
        pytest.skip(f"'{fragment}' is not in this library")
    reference = _timed_lines(_reference(song)["syncedLyrics"])
    text = "\n".join(t for _, t in reference)
    vocals = os.path.join(song["directory"], "vocals.wav")

    result = lyrics.align_lyrics(vocals, text, aligner=aligner)

    got = np.array([l["start"] for l in result["lines"]])
    want = np.array([t for t, _ in reference])
    assert len(got) == len(want), "the aligner must keep one entry per lyric line"
    error = got - want
    off = float(np.median(error))
    within = float(np.mean(np.abs(error - off) <= 2.0))

    assert result["alignedWords"] == result["totalWords"], "every word of a clean text is placed"
    assert np.all(np.diff(got) >= 0), "line starts never go backwards"
    assert within >= min_timing, f"{fragment}: {within:.0%} of lines within 2 s of the reference (offset {off:+.1f}s)"
    on_singing = _share_on_singing(vocals, got)
    assert on_singing >= min_energy, f"{fragment}: only {on_singing:.0%} of line starts sit on singing"
    return result


@pytest.mark.parametrize("fragment, min_timing, min_energy", SONGS, ids=[s[0] for s in SONGS])
def test_real_song_lines_land_on_the_singing(aligner, fragment, min_timing, min_energy):
    result = _check(aligner, fragment, min_timing, min_energy)
    assert result["warning"] is None, result["warning"]


def test_a_chorus_missing_from_the_text_is_flagged(aligner):
    song = _song("Like a stone")
    if song is None:
        pytest.skip("not in this library")
    reference = _timed_lines(_reference(song)["syncedLyrics"])
    first_third = "\n".join(t for _, t in reference[: max(3, len(reference) // 3)])
    result = lyrics.align_lyrics(os.path.join(song["directory"], "vocals.wav"), first_third, aligner=aligner)
    assert result["warning"] and "incomplete" in result["warning"]
