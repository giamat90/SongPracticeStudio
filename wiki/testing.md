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

## Frontend conventions

- `vitest.config.ts`: node environment, `restoreMocks`/`clearMocks` on, `unstubGlobals` on. `src/test/setup.ts` installs an in-memory `localStorage`; everything else a test needs (`navigator.mediaDevices`, `AudioContext`, `MediaRecorder`, timers, `requestAnimationFrame`) it stubs itself with `vi.stubGlobal`.
- `engine.test.ts` replaces `wavesurfer.js` with a small fake class (settable duration/current time, scripted `ready`/`error`) and drives the rAF tick by hand, so loop, drift correction, take window sync and auto-follow are tested deterministically.
- `player.test.ts` mocks the engine, the shared recorder and metronome (by their `@giamat90/mps-core/...` specifiers) and `../lib/tauri`, and re-imports the store with `vi.resetModules()` where module-level state matters (device watcher, persisted calibrations).
- `tests/contract/ipcContract.test.ts` parses `src/lib/tauri.ts` (and the lyrics wrappers shipped in `@giamat90/mps-core`), `src-tauri/src/commands.rs` and `lib.rs` and fails if a wrapper calls an unregistered command, sends an argument Rust does not accept, or omits a required one. It lives outside `src/` because it needs Node's `fs`; `tsc` only checks `src/`.

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

## Known behaviours the suite documents

- In the stem cascade (guitar/piano requested) the returned "other" is the residual of pass 1 plus any unrequested guitar/piano; an unrequested vocals/drums/bass is *not* folded back in, unlike a single pass. `test_cascade_other_does_not_get_unrequested_vocals_drums_or_bass_back` pins this.
- `librosa.beat.tempo` is deprecated in librosa 0.11 (moved to `librosa.feature.rhythm.tempo`); `pytest.ini` silences the `FutureWarning`. Migrate before librosa 1.0.

## When you change something

- New Tauri command → add the wrapper to `src/lib/tauri.ts` (the contract test then forces the Rust registration to match) and a case in `src/lib/tauri.test.ts`.
- New sidecar command → a branch in `main.py`, a case in `tests/test_protocol.py` (its handled-commands test lists them all).
- Bumped the yt-dlp floor → change `MIN_YT_DLP_VERSION` in `mps-core`, then both requirements files here and in VPS (see MPS conventions #10).
- Shared code (metronome, recorder, zoom/pan, updater store, lyrics engine and slice, version check) is tested in `mps-core`; see [Shared code](shared-core.md). Its tests no longer run here.
