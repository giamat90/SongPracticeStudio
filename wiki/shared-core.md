# Shared code: `@giamat90/mps-core`

Code that is identical in VPS and SPS is not kept here. It lives in
`github.com/giamat90/mps-core` (cloned beside this repository as `MPS/core`) and is
pinned by tag. Design, boundaries and the release procedure are documented in that
repository's `wiki/`; this page records how SPS uses it.

## What SPS takes from it

| Import | Replaced |
|---|---|
| `@giamat90/mps-core/metronome`, `/metronomeSync`, `/recorder`, `/zoomPan` | `src/audio/metronome.ts`, `src/lib/metronomeSync.ts`, `src/audio/recorder.ts`, `src/lib/zoomPan.ts` and their tests |
| `@giamat90/mps-core/updater` | `src/stores/updater.ts` |
| `@giamat90/mps-core/lyrics` | lyric types in `types.ts`, the lyrics wrappers and `onLyricsProgress` in `tauri.ts`, `src/stores/lyrics.ts`, the timing half of `src/lib/lyrics.ts` |
| `mps_core.lyrics`, `mps_core.version_check`, `mps_core.app` (Python) | `sidecar/lyrics.py`, `sidecar/version_check.py` and their tests |

`src/lib/constants.ts` (note/frequency maths) had no importers in SPS and was
removed together with its test; `@giamat90/mps-core/music` has the same code if it
is ever needed.

`src/lib/lyrics.ts` now holds only `canSyncLyrics(stems)`: SPS lets a song be
imported without the vocals stem, which VPS cannot, so the check is this app's.

## Wiring that lives here

- **`package.json`**: `"@giamat90/mps-core": "git+https://github.com/giamat90/mps-core.git#vX.Y.Z"`.
- **`sidecar/requirements.txt` and `requirements-test.txt`**: `git+https://github.com/giamat90/mps-core.git@vX.Y.Z#subdirectory=python`. Keep the two tags equal to each other and to `package.json`.
- **`vitest.config.ts`**: `server.deps.inline: [/@giamat90\/mps-core/]` (the package ships TypeScript source).
- **`sidecar/main.py`**: `APP = AppIdentity(name="SongPracticeStudio", url="https://github.com/giamat90/SongPracticeStudio", data_dir="~/.songpracticestudio", env_prefix="SPS")`, passed as `app=APP` to `check_yt_dlp_freshness`, `align_lyrics`, `find_lyrics`. This is why the models directory, the yt-dlp cache and `SPS_LYRICS_ENGINE` are where they always were.
- **`tests/contract/ipcContract.test.ts`**: reads `node_modules/@giamat90/mps-core/src/lyrics/ipc.ts` next to `src/lib/tauri.ts`, so the package's wrappers are checked against this app's Rust handlers.
- **`sidecar/tests/test_yt_dlp_floor.py`**: the requirement files must carry the floor `mps_core.version_check.MIN_YT_DLP_VERSION`.

## Working with it

| Task | Do |
|---|---|
| Change shared behaviour | Change it in `MPS/core`, test there, tag, then bump the pin here and in VPS. Never edit `node_modules/@giamat90/mps-core`. |
| Try a core change here before tagging | From `MPS/core`: `node scripts/push-to-app.mjs ../SPS --python ../SPS/sidecar/.venv/Scripts/python.exe`; `npm ci` restores the pinned copy. |
| Bump the pin | Edit the tag in `package.json` and both requirements files, `npm install`, run `npm test`, `npx tsc --noEmit`, `cd sidecar; python -m pytest`, `cd src-tauri; cargo test --lib`. |
| Lyrics command changed | The wrappers are the contract: the Rust handlers `load_lyrics`, `sync_lyrics`, `find_lyrics`, `delete_lyrics` and the `lyrics-progress` event must match `ipc.ts`; the contract test fails otherwise. |

## What stayed behind, and why

`KeyTranspose`, `OutputSelector`, `MicSelector`, `YouTubeCookiesControl` are
identical in both apps but read app stores and app CSS; `sidecar.rs`,
`test_util.rs` and `lyrics.rs` are largely shared but tied to each app's `Song`
model. The shared repository's `wiki/architecture.md` lists each with the reason.
