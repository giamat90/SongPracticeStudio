"""
Build the Python sidecar into a standalone executable.
Run: python build.py
Output: dist/vps-sidecar-{platform}
"""

import PyInstaller.__main__
import platform

name = "vps-sidecar"
system = platform.system().lower()

if system == "darwin":
    suffix = "aarch64-apple-darwin" if platform.machine() == "arm64" else "x86_64-apple-darwin"
elif system == "linux":
    suffix = "x86_64-unknown-linux-gnu"
elif system == "windows":
    suffix = "x86_64-pc-windows-msvc"
else:
    suffix = "unknown"

PyInstaller.__main__.run([
    "main.py",
    "--onefile",
    f"--name={name}-{suffix}",
    "--hidden-import=demucs",
    "--hidden-import=demucs.api",
    "--hidden-import=torchcrepe",
    "--hidden-import=librosa",
    "--hidden-import=soundfile",
    "--hidden-import=torch",
    "--hidden-import=torchaudio",
    "--collect-data=demucs",
    "--collect-data=crepe",
    "--noconfirm",
    "--clean",
])

print(f"\nSidecar built: dist/{name}-{suffix}")
print("Copy this to src-tauri/binaries/ for Tauri to bundle it.")
