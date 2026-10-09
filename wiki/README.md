# Song Practice Studio Wiki

**Song Practice Studio** — Tauri v2 desktop app that separates songs into stems using Demucs and provides a multi-track player for practice: per-stem mute/solo/volume, loop region, tempo control, recording over the mix with latency compensation, and mixdown export.

## Pages

| Page | Description |
|------|-------------|
| [Architecture](architecture.md) | 3-tier system overview: React → Tauri → Python sidecar |
| [Audio Engine](audio-engine.md) | Dynamic stems Map + take track, click-to-seek sync, rAF loop, output routing, timeline zoom/pan |
| [Recording & Loop Region](recording-flow.md) | TimeRuler punch region, recording lifecycle, latency compensation |
| [Data Model](data-model.md) | TypeScript interfaces (Song, Take), Rust structs, and library storage layout |
| [Python Sidecar](python-sidecar.md) | JSON-lines IPC, stem separation, BPM + key detection, take normalization, mixdown |
| [Components](components.md) | Frontend component reference and Zustand stores |
| [Dev Setup](dev-setup.md) | Prerequisites, dev.bat, build commands, and local dev notes |
| [UI Polish](ui-polish.md) | Design tokens, `polish.css` layer, accessibility conventions |
