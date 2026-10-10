"""
Build the Python sidecar into a standalone executable.
Run: python build.py
Output: dist/song-practice-studio-sidecar-{platform}
"""

import os
import PyInstaller.__main__
import platform

name = "song-practice-studio-sidecar"
system = platform.system().lower()

if system == "darwin":
    suffix = "aarch64-apple-darwin" if platform.machine() == "arm64" else "x86_64-apple-darwin"
elif system == "linux":
    suffix = "x86_64-unknown-linux-gnu"
elif system == "windows":
    suffix = "x86_64-pc-windows-msvc"
else:
    suffix = "unknown"

# Demucs shells out to bare `ffmpeg` (audio.py:read) AND `ffprobe`
# (audio.py:_read_info, used to inspect the file before decoding) on PATH.
# If static binaries have been staged at vendor/ffmpeg/{suffix}/, bundle
# them into the onefile exe so the installed app doesn't depend on the end
# user having either on their system PATH. See main.py for the runtime PATH
# injection that makes the bundled copies discoverable.
exe_suffix = ".exe" if system == "windows" else ""
vendor_ffmpeg_dir = os.path.join("vendor", "ffmpeg", suffix)
vendored_models = os.path.join("vendor", "demucs-models")
add_sep = ";" if system == "windows" else ":"

args = [
    "main.py",
    "--onefile",
    f"--name={name}-{suffix}",
    "--hidden-import=demucs",
    "--hidden-import=demucs.pretrained",
    "--hidden-import=librosa",
    "--hidden-import=soundfile",
    "--hidden-import=numpy",
    "--hidden-import=torchaudio.pipelines",
    "--collect-data=demucs",
    "--collect-all=yt_dlp",
    "--noconfirm",
    "--clean",
]

if system == "windows":
    # yt-dlp's cookiesfrombrowser fallback needs DPAPI access via pywin32 to
    # decrypt Chrome-family cookie stores; it's a lazy/optional import so
    # PyInstaller's static analysis won't find it on its own.
    args.append("--hidden-import=win32crypt")

for tool in ("ffmpeg", "ffprobe"):
    vendored_tool = os.path.join(vendor_ffmpeg_dir, f"{tool}{exe_suffix}")
    if os.path.isfile(vendored_tool):
        args.append(f"--add-binary={vendored_tool}{add_sep}.")
    else:
        print(f"WARNING: no vendored {tool} at {vendored_tool} — sidecar will "
              f"depend on {tool} being present on the end user's PATH.")

# htdemucs / htdemucs_6s weights (see fetch_models.py) so the installed app
# doesn't need internet access to download ~140MB on first use.
if os.path.isdir(vendored_models):
    args.append(f"--add-data={vendored_models}{add_sep}demucs-models")
else:
    print(f"WARNING: no vendored Demucs models at {vendored_models} — run "
          f"fetch_models.py first, or the sidecar will depend on internet "
          f"access on first use.")

PyInstaller.__main__.run(args)

print(f"\nSidecar built: dist/{name}-{suffix}")
print("Copy this to src-tauri/binaries/ for Tauri to bundle it.")
