# Loop Region & Playback

**Key files:** `src/components/player/TimeRuler.tsx` · `src/stores/player.ts`

## Punch Region

The `TimeRuler` (canvas strip above the waveform tracks) doubles as a loop region selector. There is no recording in Song Practice Studio — the "punch" terminology is inherited from the VPS fork and refers only to the playback loop region.

### Interactions

| Gesture | Action |
|---------|--------|
| **Click + drag** on empty ruler | Draw a new loop region |
| **Drag near In handle** (±8 px) | Move only the In boundary; Out stays fixed |
| **Drag near Out handle** (±8 px) | Move only the Out boundary; In stays fixed |
| **Click** (drag < 0.5 s) | Clear the region and reset loop toggle |
| **⟳ button** (right edge) | Toggle region loop on/off |

The cursor changes to `ew-resize` when hovering over a handle, `crosshair` elsewhere.

### Region State (player store, memory only — not persisted)

| Field | Type | Meaning |
|-------|------|---------|
| `punchIn` | `number \| null` | Region start (seconds) |
| `punchOut` | `number \| null` | Region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |

## Playback with a Loop Region

When `punchIn` is set, pressing **Play** always seeks to `punchIn` first.

The rAF tick in `AudioEngine` checks `punchOut` on every frame:

```ts
if (punchOut !== null && currentTime >= punchOut) {
  if (punchLoop)  → eng.seekTo(punchIn)        // loop: jump back
  else            → pause + seekTo(punchIn)    // stop and rewind
}
```

## Visual Representation

The region is drawn as a translucent red band on the `TimeRuler` canvas with I-beam caps at the In/Out handles. Each `StemTrack` also renders a `PunchOverlay` div positioned via `left`/`width` percentages of the track width, so the region is visible across all stem waveforms simultaneously.
