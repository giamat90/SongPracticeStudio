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

## Take Track

A recorded take loads as one extra WaveSurfer instance via `loadTakeTrack(filePath, container, startOffset, audioOffset, manualOffset)`. It is aligned to song time with `_takeOffset` / `_takeAudioOffset` / `_takeManualOffset` (`fileTime = songTime - (startOffset + manualOffset) + audioOffset`, the same mapping VPS uses): the rAF tick auto-plays/pauses the take as the playhead enters/exits its window, and seeks convert between song time and file time. See [Recording Flow](recording-flow.md).

**Visual alignment** (the container's `marginLeft`/`width`) is computed by `_resizeTakeTrack()` (private), called after load and again from `zoomAll`/`setScrollAll` whenever zoom or scroll changes — see [Timeline Zoom/Pan](#timeline-zoompan) below. This used to be a ratio of `container.offsetWidth` to `_duration`, which only worked because the whole song always filled the container width; now it's absolute pixels derived from `_minPxPerSec`/`_scrollTime`, which also naturally handles panning.

## Manual Take Sync

`_takeManualOffset` is a signed, seconds-valued field holding a post-recording user adjustment on top of `_takeOffset`, independent of `_takeAudioOffset`'s one-time auto-latency-compensation. `setTakeManualOffset(offset: number)` sets it and immediately re-runs `_resizeTakeTrack()` + `_seekTake(getCurrentTime())` — no store write. This is both the live-drag-preview mechanism (called on every `pointermove` from the drag handle in `TakeTrack.tsx`, see [Components: Take Sync Controls](components.md#take-sync-controls)) and the commit path — the player store's `setTakeManualOffset` action calls it once more with the final, `0.01s`-rounded value (tightened from `0.1s` to support the 10ms nudge buttons/arrow keys — same component, same commit path) after persisting via `set_take_manual_offset`.

This mutates real DOM/WaveSurfer state directly (`marginLeft`/`width`/seek position) rather than a canvas redraw — closer to how `zoomAll`/`setScrollAll` already work (imperative engine call, store synced separately), since the take rail's position is DOM state owned by the engine.

`manualOffset` is **unclamped in both directions**, including left of song time 0 — dragging the take to start before the song does not disrupt the recorded file in any way: `_seekTake`'s existing `Math.max(0, …)` guard just means the portion of the take before song time 0 is never reachable during playback (song time never goes negative), while the file on disk is untouched. There is likewise no upper-bound clamp, consistent with a take already being allowed to run past the song's duration.

## Output Device Routing

`setOutputDevice(deviceId)` re-routes every existing instance via `setSinkId` and remembers the id so newly created stem/take instances are routed on creation too (a fresh instance otherwise defaults to the system device).

## Key Transpose

Ported from VPS 2026-09-05, generalized from VPS's fixed vocals/instrumental pair to SPS's dynamic stem set. `player.ts`'s `setTranspose(semitones)` resolves each stem's file path — the plain `{songDir}/{stem}.wav` at `semitones === 0`, or the cached/rendered `pitch_shift_song(songDir, song.stems, semitones)` result otherwise (phase vocoder, Rust-cached under `{songDir}/pitched/{n}/{stem}.wav`) — then calls `AudioEngine.reloadStemsFromPaths(paths: Record<string, string>)`.

`reloadStemsFromPaths` pauses playback, calls `.load(url)` on every `_stems` Map entry that has an entry in `paths` (awaiting each instance's `"ready"`/`"error"` event, same pattern as `load()`'s initial creation), re-reads `_duration` from `_master`, reseeks to the pre-shift `currentTime`, and resumes playback if it was playing. This swaps the underlying audio in place rather than destroying/recreating WaveSurfer instances, so containers, per-stem volumes, mute/solo state, zoom/scroll, and the take track are all untouched — the same trade VPS's two named `loadVocalsFromPath`/`loadInstrumentalFromPath` methods make, generalized to one method iterating the Map instead of two fixed instances.

## Click-to-Seek Sync

WaveSurfer's `"interaction"` event fires only on user clicks (not programmatic `seekTo`). When the user clicks any stem waveform, the engine converts the click position to an absolute time and calls `seekTo()` on all other instances. The `"interaction"` event (rather than the older `"seeking"`) avoids the infinite seek loop that arises when each `seekTo` would trigger another event.

## Time Update Loop

`_startTimeUpdate()` runs a `requestAnimationFrame` loop at 60 fps. Each tick:

- **Loop detection** — if `currentTime >= _loopEnd`, seeks all stems to `_loopStart`
- **UI notifications** — throttled to ~30 fps (33 ms gate) via `_lastNotifyTime`, halving React re-render rate
- **Drift correction** — every 250 ms (`DRIFT_CHECK_INTERVAL_MS`) `_correctDrift()` re-seeks (`setTime()`) any stem more than 50 ms (`DRIFT_TOLERANCE_S`) from the reference stem. A volume-0 (muted) `<audio>` element does not stay locked to the audio-device clock and runs ahead, so the reference is the master unless it is silent (`_silentStems`, set in `setStemVolume`), in which case the first audible stem is used. A playing take is re-synced to the same reference.

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

## Volume, Mute, Solo

Per-stem volume, mute, and solo resolve to one **effective gain** per instance in the player store's `effectiveStemGain(name, rawVolume, mutedStems, soloedStem)` (solo silences every other track including the take; mute zeroes that track), applied through `engine.setStemVolume` / `setTakeVolume` by `syncTrackVolumes`. The same helper is reused by `buildMixSources` when exporting a mixdown, so the exported WAV matches what is audible.

## Playback Rate

`setPlaybackRate(rate)` calls `setPlaybackRate()` on every stem instance plus `_take` (if loaded), and remembers `rate` in `_lastPlaybackRate` — same re-application pattern as `_outputDeviceId` above, for the same reason: `_take` is destroyed and recreated on every take switch (`loadTakeTrack`), so a rate change only ever reached whichever take instance existed *at that moment*.

**Fixed bug (2026-08-11, ported from a VPS fix):** `loadTakeTrack()` never applied the current rate to the freshly created take instance, so switching takes while at a non-default speed silently reset the newly loaded take to 1x (already-loaded takes were unaffected — `setPlaybackRate()` already covered `_take` live). Fixed by applying `_lastPlaybackRate` to `_take` right after creation, mirroring `_outputDeviceId`'s re-application via `setSinkId`. VPS had a second half to this same bug — `setPlaybackRate()` not touching `take` at all — that doesn't apply here; SPS's `setPlaybackRate()` already included `_take`.

## Lifecycle

`loadStem(name, filePath, container)` — creates a WaveSurfer instance for one stem, attaches the `"interaction"` handler, and wires the `"finish"` event on the master stem to call `_finishCb`.

`destroy()` — destroys all WaveSurfer instances and clears the map. Called by `StemView` when the song changes or the component unmounts.

## Timeline Zoom/Pan

Ctrl+wheel zooms the stem timeline continuously, centered on the mouse cursor's time position; shift+wheel pans the visible window without changing zoom. This is a custom `wheel` listener in `StemView.tsx` (see [Components: StemView](components.md#timeline-zoompan)) driving WaveSurfer 7's own core zoom/scroll primitives (`ws.zoom()`, `ws.setScrollTime()`, `ws.getWidth()`) — no zoom plugin — applied to every mounted stem (and the take, if loaded) at once.

State lives in two engine fields, mirrored into the player store (`minPxPerSec`, `scrollTime`) so `TimeRuler` and `PunchOverlay` can stay aligned:

| Field | Meaning |
|-------|---------|
| `_minPxPerSec` | Current zoom level, in WaveSurfer's own pixels-per-second unit |
| `_scrollTime` | Song time (seconds) at the left edge of the visible window |

```ts
getMinPxPerSec(): number {              // dynamic lower zoom bound — "whole song fits"
  return this._master && this._duration > 0 ? this._master.getWidth() / this._duration : 1;
}

zoomAll(minPxPerSec, scrollTime): void {       // ctrl+wheel
  for (const ws of this._allInstances()) { ws.zoom(minPxPerSec); ws.setScrollTime(scrollTime); }
  this._resizeTakeTrack();
}

setScrollAll(scrollTime): void {               // shift+wheel, resize reclamp, auto-follow
  for (const ws of this._allInstances()) ws.setScrollTime(scrollTime);
  this._resizeTakeTrack();
}
```

`_allInstances()` iterates `[...this._stems.values(), this._take]` — the same "every mounted instance" idea VPS expresses over its fixed vocals/instrumental/take trio. The lower zoom bound is computed on demand from the master stem's live container width rather than stored, since it changes across a window resize. `loadSong` calls `zoomAll(getMinPxPerSec(), 0)` once at load — this makes the pre-existing implicit "whole song fills the container" behavior an explicit zoom-level-1 baseline, so nothing changes visually for anyone who never touches ctrl/shift+wheel.

**No new cross-instance sync event is needed** (unlike `"interaction"` for playhead sync above) — zoom/pan is driven top-down: the wheel handler computes `{minPxPerSec, scrollTime}` once and `zoomAll`/`setScrollAll` sets every instance synchronously, so there's no async race to guard against.

**Lockstep prerequisites:** every `WaveSurfer.create()` call (per-stem and take) now passes `hideScrollbar: true, autoScroll: false, autoCenter: false`. `hideScrollbar` prevents a user from dragging one stem's own internal scrollbar directly (which would fire that instance's `"scroll"` event with nothing syncing it to the others, by design — see above). `autoScroll`/`autoCenter` default `true` in WaveSurfer and would let each stem auto-follow its own playhead independently; since per-instance `<audio>` clocks aren't frame-identical, that would visibly micro-desync the rows while zoomed in and playing.

**Auto-follow while playing:** with per-instance auto-scroll disabled, something has to keep the playhead in view while zoomed in and playing — that's a block inside the existing `_startTimeUpdate()` rAF tick above, not a new loop. It nudges `_scrollTime` forward once the playhead crosses 85% of the visible window (`FOLLOW_MARGIN_RATIO`, in `src/lib/zoomPan.ts`), or snaps the window to include the playhead if a seek/loop jump lands it behind the window. A manual ctrl/shift+wheel action (`noteManualScrollInteraction()`, called from the wheel handler) suppresses auto-follow for 800ms (`FOLLOW_RESUME_SUPPRESS_MS`) afterward — otherwise a shift+wheel pan during playback would get overridden by auto-follow on the very next animation frame.

`onScrollChange(cb)` registers a callback the player store uses to mirror engine-initiated scroll changes (auto-follow, resize reclamp) back into Zustand — the wheel handler updates the store directly since it already has the new values, but auto-follow runs inside the engine with no store access of its own.

The zoom-to-cursor and pan math itself (exponential zoom factor, bounds clamping) is pure and lives in `src/lib/zoomPan.ts` — byte-identical to VPS's copy, designed once for both since neither app had any prior zoom/scroll code to adapt. See [Components: StemView](components.md#timeline-zoompan) for the wheel-handler wiring and the exact formulas.

**Fixed bug (2026-10-10):** the practice room could show "No audio loaded" above the waveforms even though the song loaded and played. `load()` guarded its await with `_stems.size === 0`, but React StrictMode (dev) runs the load effect twice, so a second `load()` had already refilled `_stems` with fresh, still-undecoding instances; the first carried on with them (duration 0) and `loadSong` then called `zoomAll()`, where WaveSurfer's `zoom()` throws "No audio loaded" — and `StemView` renders any `loadSong` error. `destroy()` now bumps a `_loadToken` that `load()` captures after its own `destroy()` and re-checks after the await: `load()` returns `false` when superseded or destroyed (`true` otherwise, including "no stem had a container"), and `loadSong` returns without touching state on `false`.

