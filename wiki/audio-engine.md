# Audio Engine

**File:** `src/audio/engine.ts` — `AudioEngine` class

## Design: Dynamic Stems Map

The engine holds a `Map<string, WaveSurfer>` — one entry per loaded stem. The map is populated by `StemView.tsx` when a song is selected, calling `engine.loadStem(name, filePath, container)` for each stem in `song.stems`.

```
Map {
  "vocals"  → WaveSurfer instance
  "drums"   → WaveSurfer instance
  "bass"    → WaveSurfer instance
  "guitar"  → WaveSurfer instance
  "piano"   → WaveSurfer instance
  "other"   → WaveSurfer instance
}
```

The **first stem loaded** (vocals if present, otherwise the first in the array) becomes the **master clock**: `getCurrentTime()`, `getDuration()`, and the `"finish"` event are all read from the master instance.

## Click-to-Seek Sync

WaveSurfer's `"interaction"` event fires only on user clicks (not programmatic `seekTo`). When the user clicks any stem waveform, the engine converts the click position to an absolute time and calls `seekTo()` on all other instances. The `"interaction"` event (rather than the older `"seeking"`) avoids the infinite seek loop that arises when each `seekTo` would trigger another event.

## Time Update Loop

`_startTimeUpdate()` runs a `requestAnimationFrame` loop at 60 fps. Each tick:

- **Loop detection** — if `currentTime >= _loopEnd`, seeks all stems to `_loopStart`
- **UI notifications** — throttled to ~30 fps (33 ms gate) via `_lastNotifyTime`, halving React re-render rate

## Stem Colors

Stem waveform colors are defined in `STEM_COLORS` at the top of `engine.ts`:

| Stem | Color |
|------|-------|
| vocals | `rgba(74,158,255,0.85)` blue |
| drums | `rgba(180,80,220,0.85)` purple |
| bass | `rgba(60,200,100,0.85)` green |
| guitar | `rgba(255,140,30,0.85)` orange |
| piano | `rgba(255,220,50,0.85)` yellow |
| other | `rgba(160,160,160,0.85)` gray |

## Playback Rate

`setPlaybackRate(rate)` calls `setPlaybackRate()` on every instance in the map simultaneously. The rate is persisted in the player store and re-applied whenever new stems are loaded.

## Lifecycle

`loadStem(name, filePath, container)` — creates a WaveSurfer instance for one stem, attaches the `"interaction"` handler, and wires the `"finish"` event on the master stem to call `_finishCb`.

`destroy()` — destroys all WaveSurfer instances and clears the map. Called by `StemView` when the song changes or the component unmounts.
