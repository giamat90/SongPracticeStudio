# Song Analyzer Wiki

**Song Analyzer** — Tauri v2 desktop app that separates songs into stems using Demucs and provides a multi-track player for analysis and practice.

## Pages

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | 3-tier system overview: React → Tauri → Python sidecar |
| [Audio Engine](audio-engine.md) | Dynamic stems Map, click-to-seek sync, rAF loop |
| [Loop Region & Playback](recording-flow.md) | TimeRuler punch region: draw, edit, loop |
| [Data Model](data-model.md) | TypeScript interfaces, Rust structs, and library storage layout |
| [Python Sidecar](python-sidecar.md) | JSON-lines IPC, stem separation, BPM + key detection |
| [Components](components.md) | Frontend component reference and Zustand stores |
| [Dev Setup](dev-setup.md) | Prerequisites, dev.bat, build commands, and local dev notes |
