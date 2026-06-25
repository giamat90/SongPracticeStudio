# VPS Wiki

**Vocal Practice Studio** — Tauri v2 desktop app for singers to practice against separated instrumental tracks, record takes, and analyze their performance.

## Pages

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | 3-tier system overview: React → Tauri → Python sidecar |
| [Audio Engine](audio-engine.md) | Dual WaveSurfer playback, sync, looping, device routing |
| [Recording Flow](recording-flow.md) | Recording lifecycle and Windows WASAPI audio routing quirks |
| [Data Model](data-model.md) | TypeScript interfaces, Rust structs, and library storage layout |
| [Python Sidecar](python-sidecar.md) | JSON-lines IPC, stem separation, pitch detection, pitch shifting |
| [Components](components.md) | Frontend component reference and Zustand store |
| [Dev Setup](dev-setup.md) | Prerequisites, build commands, and local development notes |
