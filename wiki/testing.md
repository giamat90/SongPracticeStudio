# Testing

Three suites, one per language, plus a few tests that deliberately cross the language boundary. All of them run in CI (`.github/workflows/test.yml`); `release.yml` still only builds installers.

| Suite | Command | Where | What it covers |
|---|---|---|---|
| Frontend | `npm test` (`npx vitest run`) | `src/**/*.test.ts`, `tests/**/*.test.ts` | pure libs, audio engine/recorder/metronome with fakes, the Zustand stores with the Tauri boundary mocked, the TS ↔ Rust IPC contract |
| Rust | `cargo test --lib` (in `src-tauri/`) | `#[cfg(test)]` modules + `src/integration_tests.rs` | library/take persistence, serde wire format, sidecar message parsing, zip export, and the **real** sidecar process driven through the real command bodies |
| Python sidecar | `python -m pytest` (in `sidecar/`, venv active) | `sidecar/tests/` | take normalization, mixdown rendering, the stem pipeline with Demucs faked, key/chord/bass-tab analysis, key transpose, the stdio protocol of `main.py`, yt-dlp import flow, version check |

Coverage of the frontend: `npx vitest run --coverage` (v8; `src/lib`, `src/audio`, `src/stores`, ~98 % lines — the uncovered remainder is the React hook in `chords.ts`).

## Setup

```powershell
npm install                                   # vitest + @vitest/coverage-v8
cd sidecar
.\.venv\Scripts\python -m pip install -r requirements-test.txt   # pytest + the light audio stack (no torch/demucs)
```

`requirements-test.txt` is a subset of `requirements.txt`. Demucs is never run by the tests (it needs torch and model weights): `processor._run_demucs` is replaced by a fake that returns constant-valued stems, so model selection, stem merging, file output, progress and the non-fatal analysis stages are all exercised without it. `SPS_SKIP_SLOW=1` skips the tests marked `slow` (process spawning).

## Coverage of the other two languages

The vitest config measures `lib`, `audio` and `stores` only, so its ~97 % hides the components (about 10-15 %). Measure everything with `npx vitest run --coverage --coverage.include='src/**'`.

- **Python:** `pytest-cov` is in `sidecar/requirements-test.txt`; `sidecar/.coveragerc` omits tests, the venv, vendored models and the pitch lab. `cd sidecar; python -m pytest --cov=.` (first run on a machine takes minutes: the suite drives real audio). `main.py` reads low (about 33 %) because the Rust tests exercise it in a subprocess; `build.py` and `fetch_models.py` are build scripts.
- **Rust:** `cargo install cargo-llvm-cov` and `rustup component add llvm-tools-preview` once, then `cd src-tauri; cargo llvm-cov --lib` (a full instrumented rebuild; set `CARGO_TARGET_DIR` elsewhere to keep your build cache). Inline `#[cfg(test)]` modules count as covered, so for a production-only figure export LCOV (`cargo llvm-cov report --lcov --output-path x.lcov`) and ignore lines after the `#[cfg(test)]` marker. The gaps are Tauri glue that needs a live window (`commands.rs`, the `windows.rs` wrappers).

How to read these numbers: [Code metrics: a short course](../../wiki/code-metrics-guide.md); the 2026-10-17 results are in [Code metrics snapshot](../../wiki/code-metrics-2026-10-17.md).

## Frontend conventions

- `vitest.config.ts`: node environment, `restoreMocks`/`clearMocks` on, `unstubGlobals` on. `src/test/setup.ts` installs an in-memory `localStorage`; everything else a test needs (`navigator.mediaDevices`, `AudioContext`, `MediaRecorder`, timers, `requestAnimationFrame`) it stubs itself with `vi.stubGlobal`.
- `engine.test.ts` replaces `wavesurfer.js` with a small fake class (settable duration/current time, scripted `ready`/`error`) and drives the rAF tick by hand, so loop, drift correction, take window sync and auto-follow are tested deterministically.
- `player.test.ts` mocks the engine, the shared recorder and metronome (by their `@giamat90/mps-core/...` specifiers) and `../lib/tauri`, and re-imports the store with `vi.resetModules()` where module-level state matters (device watcher, persisted calibrations).
- `tests/contract/ipcContract.test.ts` asks `scripts/gen-ipc.mjs --list` for every `#[tauri::command]` and fails if `src/lib/ipc.generated.ts` is stale (`gen-ipc.mjs --check`), a command is missing from (or invented in) `generate_handler!` in `lib.rs`, or a wrapper (generated, or the lyrics/YouTube ones shipped in `@giamat90/mps-core`) calls a missing command, sends an argument Rust does not accept, or omits a required one. It lives outside `src/` because it needs Node's `fs`; `tsc` only checks `src/`.

## Rust conventions

- `storage::test_support::TestHome` points the data directory of the **current thread** at a temp dir (a `thread_local!` read by `app_data_dir()` under `cfg(test)`), so tests never touch `~/.songpracticestudio` and still run in parallel.
- Command bodies that need the sidecar or the filesystem are plain `pub(crate)` functions taking `&SidecarState` (`process_song_impl`, `import_youtube_impl`, `save_take_impl`, `pitch_shift_song_impl`, `convert_take_to_temp_wav`, `render_mix_to_temp_wav`, `write_zip_archive`); the `#[tauri::command]` wrapper only adds the `AppHandle` (progress events, Save As dialog). Tests call the plain functions — no Tauri app needed (a mock app would also need the Windows comctl32 manifest, which `cargo test` binaries do not embed).
- `integration_tests.rs` spawns `python main.py` from `sidecar/` (venv interpreter if present, else `python` on PATH) and checks, end to end: `save_take` (RMS-matched to the reference stem, the whole file kept, raw recording replaced, raw kept when normalization fails), export conversion and mixdown placement, key transpose output and its cache, and a failed song job (error event, nothing left on disk). It **skips with a message** when no sidecar environment exists; set `SPS_REQUIRE_SIDECAR=1` (CI does) to make that a failure.
- The tests set `USERPROFILE`/`HOME` for the sidecar to a temp dir so its yt-dlp freshness cache does not land in the real home.

## Sidecar conventions

- `tests/helpers.py` synthesises audio with a known pitch/level; nothing depends on checked-in audio fixtures.
- `tests/test_protocol.py` drives the real `main.py` over stdio exactly like `SidecarManager` does (ready, ping, invalid JSON, unknown command, exceptions → `error` with traceback, progress ordering, non-ASCII paths, `quit`, EOF). It also asserts that every `"cmd"` string Rust sends has a branch in `main.py`.
- `tests/test_processor.py` uses `FakeDemucs`/`FakeTensor` (numpy stand-ins for the two torch calls `_save_stem` makes) to pin down which model runs for which stem request, what lands in `other`, the progress ladder (0→0.75 separation, then BPM, key, chords, bass tab), and that BPM/chord/bass-tab failures degrade instead of failing the import.
- `tests/test_yt_dlp_floor.py` checks the `requirements*.txt` floors against `mps_core.version_check.MIN_YT_DLP_VERSION`; the equal-across-projects rule (MPS conventions #10) now holds by construction because the constant has one home.

## Lyrics sync tests

Details in [Lyrics Sync](lyrics.md#tests). In short: the alignment algorithm is tested without torch (a numpy Viterbi checked against torchaudio's when present, and a scripted fake acoustic model); the Rust and Python path runs in CI through the model-free `SPS_LYRICS_ENGINE=uniform` engine; `tests/test_lyrics_real.py` runs real separated stems against LRCLIB and the vocal energy, **locally only** (skips without `~/.songpracticestudio`, the cached weights or network; fetched lyrics are cached in git-ignored `sidecar/tests/_local/` and never committed). The "every command Rust sends is handled" test now scans `lyrics.rs` as well as `commands.rs`.

## Tab sync tests

Details in [Tab sync](tab-sync.md#tests). The alignment is tested on synthetic tabs and stems with a known drifting timeline (no fixtures); `tests/tabs/realTabs.test.ts` reads the maintainer's local folder of copyrighted `.gp` files and skips without it. The score builder is tested with alphaTex strings, so repeats and tracks need no files. `integration_tests.rs` drives `align_impl` through the real sidecar.

## Chord accuracy

`sidecar/chord_eval.py` is a developer tool (not part of the app or of `pytest`'s accuracy claims): it scores detected chords against a reference chart so a change to the detector is measured, not judged by ear. The unit tests only cover the scoring maths (`tests/test_chord_eval.py`); how accurate the detector is on real songs needs reference charts, which are not in the repository.

```
cd sidecar
python chord_eval.py --song-dir <library/song> --ref chart.lab             # score the stored chords.json
python chord_eval.py --manifest songs.json --detect                        # re-run the detector on the stems, in memory
python chord_eval.py --manifest songs.json --set _SWITCH_COST=0.2          # try a constant without editing the file
```

- **Reference**: a `.lab` file, one `start end label` line per segment. Labels are Harte (`C:maj7`, `Bb:min`, `N`) or plain (`Am7`, `F#`, `C/E`). The Isophonics Beatles/Queen charts are in this format.
- **Manifest**: a JSON list of `{"name", "song_dir", "ref"}`, paths relative to the manifest.
- **Score**: weighted chord symbol recall (MIREX): share of the reference's time in which the detected chord equals the reference chord, at three vocabularies. `root` ignores quality; `majmin` reduces to major/minor; `sevenths` knows maj, min, 7, maj7, min7. Reference time a vocabulary cannot express (sus/dim/aug at `majmin`) leaves the denominator.
- **Output**: per song and time-weighted overall, segment counts reference/detected (a high detected count means over-segmentation), and the ten most common mistakes in seconds.
- **`_SEVENTH_MARGIN`** was chosen with two independent sets (tune on one, hold the other out): Isophonics 12 songs vs the 11 tab-derived charts. Sevenths score at 0.02 / 0.04 / 0.07 / 0.10 / 0.14: Isophonics 38.2 / 48.3 / 55.4 / 60.5 / 62.4, tabs 47.5 / 53.5 / **56.5** / 54.3 / 51.7. The tuning set kept rewarding more margin; the held-out set peaked at 0.07 and fell after it (real sevenths lost), so 0.07 is the value. Major/minor on the held-out set: 63.2 -> 65.3. Plain chords named as sevenths were 62% of the largest mistakes before.
- **Unknown** (`X` in a chart) is left out of the score like a quality the level cannot say.
- **`--align`**: also searches a constant time offset (±10 s, 0.1 s steps, scored at root level) between chart and detection and reports the scores at that offset. Charts are written for one master of a recording; another master or edit usually differs by its lead-in. A song that scores low even aligned does not fit its chart.
- **Tab-derived charts** (`sidecar/tab_chords.py`): a second reference that comes from the user's own recordings instead of another master. `python tab_chords.py --midi song.mid --song-dir <library/song> --out song.lab` reads the MIDI export of a Guitar Pro file (repeats and tempo map already played out), builds the same score the Tab panel builds (`tabScore.ts`: roles by General MIDI program, vocals and ensembles left out), places its bars with `tab_sync.align_tab_to_stems`, and names the notes played in each beat. Checked against the app: for "Mercy" the bar times equal the ones the app stored (max difference 0.00 s). Labels are conservative: a beat that is one note or fits no chord is `X` (left out of the score), a bare fifth is `E:5` (root level only). Checked against the chord names the tab authors wrote in (523 marks, 5 tabs): where both name a major or minor chord they agree 93% of the time; a lone note named the author's root only 25% of the time, which is why it is `X` now; one tab (Beat It) has names a semitone off in places, so treat it as lower-confidence. These are inferences from notes, not ground truth. The charts and audio stay out of the repo.
- **Confidence** (`confidence` per chord in `chords.json` v5) was chosen on this harness: of three candidate signals, the cosine fit of the chosen chord to the window predicted correctness (weighted AUC 0.67; the fifth of chords with the best fit was ~85% right at major/minor level, the worst fifth ~53%), while the margin over the best chord of another root (0.52) and over any rival (0.45) predicted nothing. 12 songs, 1340 segments, offset-aligned. A modest signal, so the UI only dims, it does not hide.
- **Candidate list** (`alternatives` in `chords.json` v6) was checked with the same harness before it was built: is the reference chord among the detector's top-k candidates (the chosen chord plus its alternatives, same 12 songs, per detected segment, time-weighted)? Root 80 / 88 / 92 % at k = 1 / 2 / 3; major-minor 71 / 85 / 89 / 91 / 92 % at k = 1 / 2 / 3 / 4 / 5; sevenths 39 / 61 / 72 / 77 / 81 % at k = 1 / 2 / 3 / 4 / 5. So a wrong chord is usually in the first three guesses; that is what the editor lists.
- **Chord lab** (`sidecar/chord_lab/`, README there): the day-to-day tool built on this harness, in the manner of VPS's `pitch_lab`. `benchmark.py` (per song and overall, with a 95% interval from resampling songs), `sweep.py --tune A --heldout B` (choose a constant on one set, confirm on the other), `visualize.py` (chroma, detected and reference chords, agreement strip), `sonify.py` (song left, chords right). Data sets (`isophonics`, `tabs`) live in its gitignored `datasets/`. `tests/test_chord_lab.py` holds `lab.prepare` + `lab.detect` equal to `processor._detect_chords_full`. Reference: `tabs` unaligned 71.4 / 65.1 / 56.3 (root / major-minor / sevenths) at v0.0.63; the 71.6 / 65.3 / 56.5 quoted for that release was the same run with `--align`.
- **Neural chord engine** (`tests/test_neural_chords.py`, 41 tests): the vocabulary folding (every one of the 170 model classes lands on exactly one chord the Rust side accepts, read from `library.rs`), segmentation, engine selection (`SPS_CHORD_ENGINE`, the file, unknown values), the fallback to the classical detector, slash bass for the extra qualities and the SHA-256 refusal run in CI without torch. The real-weights tests (strict load, determinism across runs and thread counts, end to end) skip unless `python fetch_btc.py` has been run. How accurate it is on real songs is measured outside the suite, like the classical detector: see python-sidecar.md#neural-chord-engine-beta.
- `--detect` and `--set` run `processor._detect_chords` on the song folder's stems; nothing is written to the library. `--set` only takes numeric module constants.

## Known behaviours the suite documents

- In the stem cascade (guitar/piano requested) the returned "other" is the residual of pass 1 plus any unrequested guitar/piano; an unrequested vocals/drums/bass is *not* folded back in, unlike a single pass. `test_cascade_other_does_not_get_unrequested_vocals_drums_or_bass_back` pins this.
- `librosa.beat.tempo` is deprecated in librosa 0.11 (moved to `librosa.feature.rhythm.tempo`); `pytest.ini` silences the `FutureWarning`. Migrate before librosa 1.0.

## When you change something

- New Tauri command → write the Rust fn (its `///` doc becomes the wrapper's JSDoc), register it in `generate_handler!` in `lib.rs`, run `npm run gen:ipc` (the contract test fails with the missing step otherwise), and add a case in `src/lib/tauri.test.ts`.
- New sidecar command → a branch in `main.py`, a case in `tests/test_protocol.py` (its handled-commands test lists them all).
- Bumped the yt-dlp floor → change `MIN_YT_DLP_VERSION` in `mps-core`, then both requirements files here and in VPS (see MPS conventions #10).
- Shared code (metronome, recorder, zoom/pan, updater store, lyrics engine and slice, version check) is tested in `mps-core`; see [Shared code](shared-core.md). Its tests no longer run here.
