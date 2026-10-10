# Lyrics Sync

Place every line and word of a song's lyrics on the separated **vocals** stem, then show them karaoke-style above the stems in the analyzer. Click a line to jump to it.

Ported from VPS (2026-10-10, VPS PR #3). The sidecar module is VPS's `lyrics.py` with three SPS-specific lines; the design record and the original measurements live in VPS `wiki/lyrics.md` and `MPS/wiki/whats-next.md`. This page records what is different here and what was re-measured on SPS's own library.

## User flow

1. Open a song → **Lyrics (add)** tab above the stems. (A song imported *without* the vocals stem shows an explanation instead: SPS lets the user pick which stems to extract, and there is nothing to align to without `vocals`.)
2. Paste the lyrics, or press **Find online** (looks the song up on [LRCLIB](https://lrclib.net), a free community lyrics database; sends only the song title and duration). The found text lands in the box for review; nothing is saved yet.
3. Press **Sync lyrics**. Progress is streamed; the first run also downloads a ~360 MB speech model once into `~/.songpracticestudio/models/` (about 100 s on the measured connection). Typical time afterwards: 10-25 s for a 3-5 minute song on CPU.
4. The karaoke view shows every line; the line being sung is lit and centred, the sung words in it are highlighted. Clicking a line seeks to it (0.3 s early so the first word is not clipped). **Edit and re-sync** and **Remove** are beside it.

The panel sits **above** the stems list, outside its scroller. Placed below the stems (the first attempt), six stem rows pushed it off-screen and the lyrics were never visible without scrolling; this was only noticed by running the app.

## Differences from VPS

| | VPS | SPS |
|---|---|---|
| Song record | has `artist` and `kind` | neither; only `title`, `duration`, `stems` |
| Online lookup | `title` + `artist` | `title` only. SPS titles are raw YouTube titles (`Audioslave - Like a stone (HD)`), so LRCLIB's `q=` search relies on `clean_title` stripping decoration; measured below |
| Who can have lyrics | non-instrument songs | songs whose `stems` contain `vocals` and whose `vocals.wav` exists; `sync_impl` validates both before touching the sidecar |
| File location | `storage::song_dir(id)` | the song's own `directory` from `library.json` (as `read_chords` does); `load`/`delete` never create a directory, and a sync that finishes after its song was deleted fails instead of resurrecting the folder |
| Models dir | `~/.vps/models/` | `~/.songpracticestudio/models/` (a second 360 MB copy if both apps are used; apps are deliberately not coupled) |
| Test engine switch | `VPS_LYRICS_ENGINE=uniform` | `SPS_LYRICS_ENGINE=uniform` |
| Sidecar plumbing | own `ensure_sidecar` | reuses `commands::run_sidecar_command` (made `pub(crate)`) |

`sidecar/lyrics.py` differs from VPS's copy in exactly three places: `USER_AGENT`, the default models directory, and the test-engine environment variable. Keep it in step (a diff ignoring those lines should be empty).

## How it works

```
text ──parse──▶ words ──normalise──▶ letters ─┐
                                              ├─▶ CTC forced alignment ─▶ letter frames ─▶ words ─▶ lines
vocals.wav ─▶ 16 kHz mono ─▶ wav2vec2 ─▶ log-probs per 20 ms frame ┘
```

Engine: torchaudio `WAV2VEC2_ASR_BASE_960H` (English, 360 MB), windowed 20 s + 2 s context; own numpy Viterbi (tested equal to torchaudio's path, runs in CI without torch). The pipeline table, quality heuristic and storage format are the same as VPS, see VPS `wiki/lyrics.md`.

### Wire protocol

| Command | Request | Result |
|---|---|---|
| `align_lyrics` | `{vocalsPath, lyrics, modelsDir?}` + progress | `{aligner, lines[], meanScore, evidenceRatio, alignedWords, totalWords, warning}` |
| `find_lyrics` | `{title, artist?, duration?}` | `{text, synced, title, artist, duration, source}` |

Rust (`src-tauri/src/lyrics.rs`, thin wrappers in `commands.rs`): `load_lyrics`, `sync_lyrics`, `find_lyrics`, `delete_lyrics`; progress arrives on `"lyrics-progress"` (`{songId, progress, stage}`). The sidecar lock is held for the duration, like `process_song`, so a take being saved or a transpose waits behind a running sync (no cancel button).

### Storage

`~/.songpracticestudio/library/{songId}/lyrics.json`, written atomically (tmp + rename). Shape = `Lyrics` in `src/lib/types.ts` (see [Data Model](data-model.md#lyrics)). `text` is kept verbatim so it can be edited and re-synced. Deleting the song deletes it with the rest of the directory. It is not included in `export_all`.

Lyrics are on **song time**, so transposing (`pitch_shift_song`) does not change them, and tempo changes move the playhead and the lyrics together.

## Accuracy: measured on SPS's own library (2026-10-10)

Same method as VPS: Demucs-separated `vocals.wav` from the real library, LRCLIB's human-synced lines as the reference with a constant median offset removed, plus an independent check that each line starts where the vocal stem has energy (> -45 dBFS within 0.6 s). 13 of the 17 distinct library songs had a usable synced reference; the other four are bass-cover videos and "The Kill - GT", which LRCLIB has no synced entry for.

| Song (library title, shortened) | Offset removed | Within 1 s | Within 2 s | Line starts on singing | Warning |
|---|---|---|---|---|---|
| Beat It | +0.2 s | 88 % | 92 % | 96 % | none |
| Smooth Criminal | -0.4 s | 78 % | 81 % | 100 % | none |
| Immigrant Song | +1.8 s | 95 % | 95 % | 100 % | none |
| War Pigs | -1.1 s | 81 % | 96 % | 100 % | none |
| Like a stone | +0.2 s | 96 % | 96 % | 100 % | none |
| Mercy | +1.6 s | 92 % | 97 % | 100 % | none |
| Starlight (Official Music Video) | +0.4 s | 90 % | 100 % | 100 % | none |
| Starlight [HQ] | +0.2 s | 92 % | 100 % | 100 % | none |
| Firework | -0.2 s | 96 % | 96 % | 100 % | none |
| Party In The U.S.A. | -0.4 s | 83 % | 92 % | 100 % | none |
| What I've Done | -1.7 s | 82 % | 92 % | 100 % | none |
| Rolling in the Deep | 0.0 s | 93 % | 97 % | 99 % | none |
| Start A Fire | +13.5 s | 14 % | 22 % | **100 %** | none |

- **Start A Fire is a reference problem, not an alignment problem.** LRCLIB's only match is another artist's recording of 187.8 s while the library's file is 192.1 s, so the reference lines are for different audio. The aligner still put every line on singing. This is why it is not in the local real-data test list, and why "within N s of LRCLIB" is only ever a floor: the vocal-energy check is the independent half of the oracle.
- No false warnings on any correctly matched song.
- Titles needed no extra cleaning: every library title above resolved to the right LRCLIB entry through `clean_title`, including `(Lyrics)`, `[Official Music Video]`, `(HD)` and `[HQ]`.
- The live app run on "Like a stone": 24 lines, no warning, model download + sync ~120 s on the first run; 28 of 28 comparable playback samples agreed with the highlighted line.

### What the incomplete-text warning caught here

Evidence ratio (letters the model hears per letter of text; warning above 3.5) when only the first part of each song's lyrics is supplied:

| Song | Full text | First 2/3 | First 1/2 | First 1/3 |
|---|---|---|---|---|
| Rolling in the Deep | 0.97 | 1.49 | 1.90 | 2.92 (not flagged) |
| Like a stone | 1.93 | 2.81 | 3.46 | **5.71** |
| Firework | 1.62 | 2.36 | 2.90 | **4.81** |
| Smooth Criminal | 1.45 | 2.26 | 2.93 | **4.24** |
| Mercy | 2.05 | 3.13 | **3.72** | **6.11** |
| War Pigs | 2.24 | 3.35 | **4.51** | **6.86** |

Only a third of the text is reliably caught (5 of 6 songs); losing a third of it (first two thirds supplied) is never flagged. The warning catches gross omissions, not subtle ones, which is the same conclusion as on VPS's library. `test_a_chorus_missing_from_the_text_is_flagged` uses Like a stone's first third for that reason.

Other limits (English model, screamed vocals, collapsed choruses, a different song's text going undetected) are the same as VPS; see VPS `wiki/lyrics.md`.

## Tests

| Layer | File | Covers |
|---|---|---|
| sidecar | `tests/test_lyrics_text.py`, `test_lyrics_ctc.py`, `test_lyrics_align.py`, `test_lyrics_model.py`, `test_lyrics_lrclib.py` | parsing, Viterbi, timeline/warnings (scripted fake acoustic model), download and windowed inference, LRCLIB lookup offline; ported unchanged apart from the names |
| sidecar | `tests/test_lyrics_protocol.py` | the commands over the real stdio protocol (model-free `SPS_LYRICS_ENGINE=uniform`) |
| sidecar | `tests/test_protocol.py` | the set of commands `main.py` handles; every `"cmd"` Rust sends (now scanning `lyrics.rs` too) has a branch |
| sidecar | `tests/test_lyrics_real.py` | **local only**: 11 real songs from `~/.songpracticestudio` vs LRCLIB + vocal energy; skips without the library, the cached weights or network. Fetched lyrics are cached under `sidecar/tests/_local/` (git-ignored; copyrighted, never commit) |
| rust | `src/lyrics.rs`, `integration_tests.rs` | wire format, atomic persistence, validation without spawning the sidecar (empty text, unknown song, no vocals stem, missing file), no directory creation, a song deleted mid-sync, and a full round trip through the real sidecar |
| frontend | `lib/lyrics.test.ts`, `stores/lyrics.test.ts`, `lib/tauri.test.ts` | timing logic, `canSyncLyrics`, store races, IPC wrappers (the contract test also covers the four commands) |

### Running the real-data tests

```powershell
cd sidecar
.\.venv\Scripts\python -m pytest tests/test_lyrics_real.py -q
```

Needs the weights in `~/.songpracticestudio/models/` (or `~/.cache/torch/hub/checkpoints/`, or `SPS_LYRICS_ALLOW_DOWNLOAD=1`). About 5 minutes.

## Known limitations

- **Frozen sidecar:** built with `build.py`'s arguments (plus `--hidden-import=torchaudio.pipelines`, without the vendored ffmpeg/Demucs weights) and smoke-tested on 2026-10-10: it starts in ~11 s, runs the real wav2vec2 model through `align_lyrics` (32/32 words placed on a 40 s clip of a real vocals stem, ~29 s including model load), and resolves `find_lyrics`. The installer produced by `release.yml` has not been exercised, so check Lyrics once on a release candidate.
- The model is not bundled; the first sync needs internet.
- No cancel button: a sync runs to completion, and other sidecar commands wait for it.
- One lyric track per song; no manual per-line timing edits.
- Lyrics are shown in the analyzer only, not on the library cards.
