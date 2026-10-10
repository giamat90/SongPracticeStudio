# Loop Region, Recording & Playback

**Key files:** `src/components/player/TimeRuler.tsx` · `src/stores/player.ts` · `@giamat90/mps-core/recorder` · `src/components/recording/`

## Punch Region

The `TimeRuler` (canvas strip above the waveform tracks) doubles as a loop region selector. The "punch" terminology is inherited from the VPS fork; since recording landed (`a9f0806`), the region also bounds recording, and it doubles as the playback loop region.

### Interactions

| Gesture | Action |
|---------|--------|
| **Click + drag** on empty ruler | Draw a new loop region |
| **Drag near In handle** (±8 px) | Move only the In boundary; Out stays fixed |
| **Drag near Out handle** (±8 px) | Move only the Out boundary; In stays fixed |
| **Click** (drag < 0.5 s) | Clear the region and reset loop toggle |

The cursor changes to `ew-resize` when hovering over a handle, `crosshair` elsewhere.

The loop toggle itself is **not** a ruler button — it's `LoopButton.tsx` (`src/components/player/`), rendered next to `TransportControls` in `AnalyzerPage.tsx`'s topbar (see `wiki/components.md#loopbutton`). It used to be an in-ruler `⟳` button, ported from VPS's equivalent (moved on both sides 2026-07-10).

### Region State (player store, memory only — not persisted)

| Field | Type | Meaning |
|-------|------|---------|
| `punchIn` | `number \| null` | Region start (seconds) |
| `punchOut` | `number \| null` | Region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |

## Playback with a Loop Region

When `punchIn` is set, pressing **Play** always seeks to `punchIn` first.

`onTimeUpdate` in `stores/player.ts` (not the engine's rAF tick — that only handles `_loopStart`/`_loopEnd`, the separate legacy A/B loop with no UI exposed) checks `punchOut` on every frame:

```ts
if (punchOut !== null && time >= punchOut) {
  if (isRecording)       → stopRecording()           // save take
  else if (punchLoop)    → eng.seekTo(punchIn)        // loop: jump back
  else                   → pause + seekTo(punchIn)    // stop and rewind
}
```

## Visual Representation

The region is drawn as a translucent red band on the `TimeRuler` canvas with I-beam caps at the In/Out handles. Each `StemTrack` also renders a `PunchOverlay` div positioned via `left`/`width` percentages of the track width, so the region is visible across all stem waveforms simultaneously.

## Recording Lifecycle

`startRecording` (player store): if a take is currently selected, deselects it first (`activeTakeId = null` + `eng.clearTakeTrack()`) — otherwise the previous take stays loaded and the engine's rAF take-window sync keeps auto-playing it whenever the playhead crosses its window during the new recording, so the performer hears their last attempt mixed into the stems. The take is untouched on disk (`takes.json` is only appended to / edited explicitly), so it stays in the take list and re-selectable — just out of playback. Then: remembers the start position (`punchIn` if set, else `currentTime`), pauses playback, opens the mic via `rec.init(selectedDeviceId)` (`VocalRecorder` from `@giamat90/mps-core/recorder`), seeks to the start position, resumes playback, then starts the `MediaRecorder`.

The recorder builds a Web Audio **channel-fix graph** (channel splitter → per-channel max merge) before the `MediaRecorder`, because some 2-input USB interfaces route the mic to only one physical channel — without it a `channelCount: 1` downmix loses ~6 dB.

**Auto-stop:** recording stops automatically when playback stops itself — the rAF `onTimeUpdate` handler calls `stopRecording()` at punch-out, and the `onFinish` handler does the same at song end — so the mic is never left running silently after the take should have ended.

`stopRecording`: drains the `MediaRecorder`, releases the mic stream, applies latency compensation to `startPosition`/`audioOffset` (below), then `saveTake` writes the take via Tauri — where the sidecar `normalize_take` **RMS-matches the take's loudness against `vocals.wav`** (peak-capped) and the normalized `{takeId}.wav` replaces the raw `.webm` (the whole file is kept, including any `audioOffset` padding at its start — the player does the skipping). Selecting the saved take mounts `TakeTrack`, which loads it into the engine aligned at its `startPosition`.

## Latency Compensation

The player hears the stems with a monitoring delay (typically 50–300 ms on USB WASAPI interfaces). To compensate, the recorded audio's `startPosition` is shifted back by the measured round-trip latency in `stopRecording()`; if that pushes it below 0 the remainder is stored as `audioOffset` (seconds to skip into the take file).

### Compensation source (priority order)

1. **Calibrated offset** (preferred) — the selected input device's entry in `recordingOffsets`, set by the click calibration flow, used only if not stale.
2. **AudioContext estimate** (fallback) — `outputLatency + baseLatency` plus the mic track's `getSettings().latency`. Also used when a stored calibration is stale; the store flag `usedLatencyFallback` records which path ran. Recording is never blocked.

### Calibration entry schema

Each `recordingOffsets` entry is a `CalibrationEntry` (`player.ts`), keyed by input `deviceId` and persisted to `localStorage` (`songpracticestudio_recording_offsets`):

```ts
interface CalibrationEntry {
  offset: number;  // ms
  stale?: boolean; // set by device-change invalidation
  madMs?: number;  // measurement-spread MAD; absent for manual entries
  outputDeviceId?: string; // unused in SPS (calibration plays through the default output);
                           // kept schema-compatible with VPS
}
```

Legacy plain-number entries are migrated on load (`n → { offset: n }`). Manually typed offsets are stored bare, which also clears a stale flag.

### Staleness and invalidation

A `devicechange` listener (registered from `fetchAudioDevices`) re-enumerates devices and, only if the device set actually changed, marks stale any entry whose device is no longer present. Stale entries are kept — never deleted — but skipped at recording time. When the active input's calibration is stale or missing, `RecordingOffsetControl` shows a non-blocking "recalibrate?" banner that triggers the normal Cal flow.

### Per-device calibration and confidence

`RecordingOffsetControl` plays 4 count-in + 8 measured clicks, records the response (clap, tap, or pluck — any sharp sound), detects onsets via an RMS envelope, and stores the median offset. It also computes the MAD (median absolute deviation) of the detected offsets as `madMs`:

| MAD | Confidence |
|---|---|
| ≤ 5 ms | high |
| 5–15 ms | medium |
| > 15 ms | low |

A confidence chip is shown next to the calibrated value and in the result banner; low confidence adds a hint to re-run in a quieter room. Low-confidence values are never auto-discarded.

### Sanity bounds

A measurement is rejected (error state, nothing persisted, any previous offset untouched) when the median is negative, exceeds 500 ms (`MAX_OFFSET_MS`), or fewer than 5 of the 8 measured clicks produced a detected onset (`MIN_DETECTED_CLAPS`). Rejected raw values are logged via `console.debug("[calibration] rejected: …")`.

### Drift-check instrumentation

On stop, takes longer than 90 s log `[drift-check] takeDuration=…s input=… output=…` via `console.info`. Diagnostics only — no drift is measured or corrected.
