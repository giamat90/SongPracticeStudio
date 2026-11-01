"""
YouTube audio importer.
Downloads best audio via yt-dlp, then runs the full process() pipeline.
Requires ffmpeg on PATH for the WAV post-processing step.
"""

import os
import re
import sys
import yt_dlp
from processor import process
from mps_core.identity import artist_from_ytdlp
from mps_core.version_check import MIN_YT_DLP_VERSION as _MIN_YT_DLP_VERSION
from mps_core.yt_download import FAST_FAIL_OPTS, AttemptBudget, attempt_stage, download_hook

_BROWSERS = ["chrome", "firefox", "edge", "brave", "opera"]


def _version_tuple(v: str) -> tuple:
    parts = []
    for p in v.split("."):
        digits = "".join(ch for ch in p if ch.isdigit())
        parts.append(int(digits) if digits else 0)
    return tuple(parts)


def _yt_dlp_is_outdated() -> bool:
    try:
        return _version_tuple(yt_dlp.version.__version__) < _version_tuple(_MIN_YT_DLP_VERSION)
    except Exception:
        return False


def _js_runtime_opts() -> dict:
    """yt-dlp needs a JavaScript runtime (Deno) to solve YouTube's signature and
    n challenges; without one a signed-in extraction fails with "The page needs
    to be reloaded". In a dev venv yt-dlp finds the `deno` wheel's executable by
    itself. The frozen sidecar unpacks to a temp dir yt-dlp does not search, so
    it is pointed at the copy build.py bundled there.
    """
    if not getattr(sys, "frozen", False):
        return {}
    name = "deno.exe" if os.name == "nt" else "deno"
    path = os.path.join(getattr(sys, "_MEIPASS", os.path.dirname(sys.executable)), name)
    if os.path.isfile(path):
        return {"js_runtimes": {"deno": {"path": path}}}
    print(
        f"[yt_importer] the bundled Deno was not found at {path}: YouTube imports "
        "that need a signed-in session will fail",
        file=sys.stderr,
    )
    return {}


def _raise_import_error(exc: Exception):
    if isinstance(exc, yt_dlp.utils.DownloadError) and _yt_dlp_is_outdated():
        raise RuntimeError(
            f"yt-dlp {yt_dlp.version.__version__} is older than the known-good floor "
            f"{_MIN_YT_DLP_VERSION} pinned in requirements.txt. YouTube periodically "
            "breaks compatibility with older yt-dlp clients, which is the likely cause "
            "here, not a bad URL or network issue. Fix: `pip install -U -r "
            "requirements.txt` in the dev venv, or rebuild the sidecar for an installed "
            f"build. Original error: {exc}"
        ) from exc
    raise exc


def import_yt(
    url: str,
    output_dir: str,
    stems_to_extract=None,
    high_quality: bool = False,
    on_progress=None,
    cookies_path: str | None = None,
) -> dict:
    """
    Progress: download occupies 0.0–0.15, existing pipeline fills 0.15–1.0. A download
    of unknown size reports -1 (indeterminate); every attempt names itself in the stage.
    Returns the same dict as processor.process(), with 'title' added.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)
    base_opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(output_dir, "source.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        **FAST_FAIL_OPTS,
        **_js_runtime_opts(),
    }

    # A user-supplied cookies.txt (Netscape format, exported once via a
    # browser extension) sidesteps the live-browser extraction problems
    # below entirely — no lock/decryption dependency on a running browser,
    # so it's tried first when configured. Falls through to the old
    # extract-from-a-running-browser cascade otherwise (kept for anyone who
    # hasn't set one up): try without cookies first, then cycle through
    # installed browsers. Chromium browsers' cookie stores are encrypted
    # with a key only reliably reachable while that browser is running
    # (Chrome 127+ "app-bound encryption"), which makes that path fragile —
    # see MPS wiki/known-issues.md.
    attempts = []
    if cookies_path:
        if os.path.isfile(cookies_path):
            print(f"[yt_importer] trying cookies file: {cookies_path}", file=sys.stderr)
            attempts.append({"cookiefile": cookies_path})
        else:
            print(f"[yt_importer] cookies file not found, skipping: {cookies_path}", file=sys.stderr)
    else:
        print("[yt_importer] no cookiesPath configured", file=sys.stderr)
    attempts += [{}] + [{"cookiesfrombrowser": (b,)} for b in _BROWSERS]
    last_error: Exception | None = None
    # A blocked connection fails every attempt slowly; stopping new attempts after a
    # while surfaces the error instead of leaving the import looping silently.
    budget = AttemptBudget()

    for index, extra in enumerate(attempts):
        if last_error is not None and budget.expired():
            print("[yt_importer] attempt budget used up, giving up", file=sys.stderr)
            break
        stage = attempt_stage(index, len(attempts), extra)
        on_progress(0.0, stage)
        opts = {**base_opts, **extra, "progress_hooks": [download_hook(on_progress, stage)]}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get("title", "Unknown")
                artist = artist_from_ytdlp(info)
            last_error = None
            break
        except Exception as exc:
            last_error = exc
            # Cookie-extraction attempts are best-effort (e.g. a missing
            # pywin32 install can raise something other than DownloadError
            # while decrypting a browser's cookie store) — any failure on
            # those just moves on to the next browser. For the no-cookie
            # attempt, only retry on errors a cookie session is known to
            # fix; bail immediately otherwise so real errors (e.g. video
            # unavailable) aren't masked behind a pointless retry loop.
            # "403 Forbidden" while downloading the actual media data is
            # included alongside the "Sign in to confirm"/bot-check text —
            # same root cause (an unauthenticated request YouTube rejects),
            # different wording, and just as commonly fixed by cookies.
            is_cookie_attempt = "cookiesfrombrowser" in extra or "cookiefile" in extra
            is_retryable = isinstance(exc, yt_dlp.utils.DownloadError) and (
                "Sign in to confirm" in str(exc)
                or re.search(r"\bbot\b", str(exc).lower())
                or "403" in str(exc)
                or "forbidden" in str(exc).lower()
            )
            if not is_cookie_attempt and not is_retryable:
                _raise_import_error(exc)
            # Clean up any partial file before next attempt.
            for f in os.listdir(output_dir):
                if f.startswith("source."):
                    try:
                        os.remove(os.path.join(output_dir, f))
                    except OSError:
                        pass

    if last_error is not None:
        _raise_import_error(last_error)

    source_wav = os.path.join(output_dir, "source.wav")
    if not os.path.exists(source_wav):
        for f in os.listdir(output_dir):
            if f.startswith("source."):
                source_wav = os.path.join(output_dir, f)
                break
        else:
            raise FileNotFoundError(f"yt-dlp produced no output file in {output_dir}")

    def remapped(value: float, stage: str):
        on_progress(0.15 + value * 0.85, stage)

    result = process(source_wav, output_dir, stems_to_extract=stems_to_extract, high_quality=high_quality, on_progress=remapped)
    result["title"] = title
    result["artist"] = artist
    return result
