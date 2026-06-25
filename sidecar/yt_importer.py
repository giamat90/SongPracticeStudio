"""
YouTube audio importer.
Downloads best audio via yt-dlp, then runs the full process() pipeline.
Requires ffmpeg on PATH for the WAV post-processing step.
"""

import os
import yt_dlp
from processor import process

_BROWSERS = ["chrome", "firefox", "edge", "brave", "opera"]


def import_yt(url: str, output_dir: str, on_progress=None) -> dict:
    """
    Progress: download occupies 0.0–0.15, existing pipeline fills 0.15–1.0.
    Returns the same dict as processor.process(), with 'title' added.
    """
    if on_progress is None:
        on_progress = lambda v, s: None

    os.makedirs(output_dir, exist_ok=True)
    on_progress(0.0, "downloading")

    def ydl_hook(d):
        if d["status"] == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate") or 1
            frac = min(d.get("downloaded_bytes", 0) / total, 1.0)
            on_progress(frac * 0.15, "downloading")
        elif d["status"] == "finished":
            on_progress(0.15, "downloading")

    base_opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(output_dir, "source.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [ydl_hook],
    }

    # Try without cookies first, then fall back through installed browsers.
    attempts = [{}] + [{"cookiesfrombrowser": (b,)} for b in _BROWSERS]
    last_error: Exception | None = None

    for extra in attempts:
        opts = {**base_opts, **extra}
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(url, download=True)
                title = info.get("title", "Unknown")
            last_error = None
            break
        except yt_dlp.utils.DownloadError as exc:
            last_error = exc
            # Only retry on bot-detection; bail immediately for other errors.
            if "Sign in to confirm" not in str(exc) and "bot" not in str(exc).lower():
                raise
            # Clean up any partial file before next attempt.
            for f in os.listdir(output_dir):
                if f.startswith("source."):
                    try:
                        os.remove(os.path.join(output_dir, f))
                    except OSError:
                        pass

    if last_error is not None:
        raise last_error

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

    result = process(source_wav, output_dir, on_progress=remapped)
    result["title"] = title
    return result
