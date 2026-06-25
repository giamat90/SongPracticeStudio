@echo off
REM ============================================================
REM  VPS — Vocal Practice Studio  |  Dev environment setup
REM ============================================================

REM ── Rust / Cargo ────────────────────────────────────────────
set PATH=%USERPROFILE%\.cargo\bin;%PATH%

REM ── Node (adjust if nvm or custom install path is used) ─────
set PATH=%APPDATA%\npm;%PATH%

REM ── Python sidecar virtualenv ───────────────────────────────
set VENV=%~dp0sidecar\.venv
set PATH=%VENV%\Scripts;%PATH%
set VIRTUAL_ENV=%VENV%
set PYTHONPATH=%~dp0sidecar

REM ── Silence noisy Python / torch warnings ───────────────────
set PYTHONWARNINGS=ignore
set TOKENIZERS_PARALLELISM=false

REM ── Optional: force CPU-only torch (no CUDA errors on dev) ──
set CUDA_VISIBLE_DEVICES=-1

REM ── Verify key tools are reachable ─────────────────────────
echo.
echo [VPS] Checking tools...
where cargo  >nul 2>&1 && echo   cargo   : OK || echo   cargo   : NOT FOUND — check Rust install
where node   >nul 2>&1 && echo   node    : OK || echo   node    : NOT FOUND — check Node install
where python >nul 2>&1 && echo   python  : OK || echo   python  : NOT FOUND — check venv path
echo.

REM ── Launch ──────────────────────────────────────────────────
echo [VPS] Starting dev server...
echo       Run:  npm run tauri dev
echo.
cmd /k "cd /d %~dp0"
