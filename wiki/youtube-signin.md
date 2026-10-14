# YouTube sign-in (in-app cookies)

Settings → **YouTube account** → *Sign in to YouTube*: signs in to Google in a private window and saves the session cookies yt-dlp needs, instead of asking the user to export a `cookies.txt` by hand. Ported from VPS (VPS PRs #28 and #29, 2026-10-14); the full design, the security reasoning and the hand-test checklist live in VPS's `wiki/youtube-signin.md`. This page records what is specific to SPS.

## Where the code lives

The window, cookie reading, cookies-file writer, navigation allowlist and `may_invoke` are the `mps-youtube-signin` crate in mps-core (`rust/youtube-signin`, shared with VPS). `src-tauri/src/youtube_signin.rs` is only the two `#[tauri::command]`s binding it to `~/.songpracticestudio`. The TypeScript half (`signInYoutube`, `signOutYoutube`, `cookiesSource`, `isSessionExpiredError`) is `@giamat90/mps-core/youtube`. Change behaviour in mps-core and bump the pins (`package.json`, `requirements*.txt`, the `mps-youtube-signin` entry in `src-tauri/Cargo.toml`).

## Flow

1. `sign_in_youtube` (`src-tauri/src/youtube_signin.rs`) opens a window labelled `youtube-signin` in private mode on Google's sign-in page.
2. It polls the window's cookies until a real session exists (`LOGIN_INFO` plus a session cookie on youtube.com), waits 2 s, and writes only the google.com / youtube.com cookies to `~/.songpracticestudio/youtube_cookies.txt` (Netscape format, atomic write).
3. The UI stores that path as `youtubeCookiesPath` (`sps_settings`), so `import_youtube` and the sidecar are unchanged: `cookiefile` is tried first, then the old cascade.
4. `sign_out_youtube` deletes only that managed file. A cookies.txt the user chose is never touched; choosing one by hand remains available.

## When the session expires

An import that carried a cookies file and was turned down in a way a fresh sign-in can fix (bot check, 403, "cookies are no longer valid"; `isSessionExpiredError`) sets `sessionExpired` in the library store, and the error banner shows **Sign in again and retry**. One click opens the sign-in window, stores the new cookies path and repeats the same import (same stems and quality) with it (`signInAndRetryYoutube`). If the fresh session is turned down too, the message blames the network/VPN and no second offer is made. The window is never opened without a click; cancelling keeps the offer. Private or removed videos do not trigger it.

## Security

- This app has no per-command ACL either, so the invoke handler in `lib.rs` rejects every call from the `youtube-signin` webview (`youtube_signin::may_invoke`). Do not remove it.
- Navigation is limited to https on Google-owned domains, country domains by shape (`accounts.google.it`, `google.co.uk`, …); lookalikes are refused.
- Only google.com / youtube.com cookies are kept; values are never logged.
- `windows::close_all` also closes the sign-in window, so it cannot keep the app alive.

## JS runtime

A signed-in YouTube extraction needs a JavaScript runtime and the `yt-dlp-ejs` solver scripts, otherwise yt-dlp fails with "The page needs to be reloaded". `requirements.txt` installs `yt-dlp[default,deno]`; `build.py` bundles the `deno` executable and `yt_dlp_ejs`; `yt_importer._js_runtime_opts()` points the frozen sidecar at the bundled copy. The installer grows by the Deno executable (about 100 MB uncompressed).

## Status

Ported 2026-10-14 on `feat/youtube-signin`; suites green (vitest, cargo, pytest). Not yet hand-tested in SPS.
