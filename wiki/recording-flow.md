# Recording Flow

**Key files:** `src/audio/recorder.ts` · `src/stores/player.ts`

## Overview

Recording is initiated by the user clicking the record button. The flow is carefully sequenced to work around Windows WASAPI audio routing behavior.

## Punch-in / Punch-out Region

The `TimeRuler` (canvas strip above the waveforms) is the punch region selector:

| Gesture | Action |
|---------|--------|
| **Click + drag** on empty ruler | Draw a new punch region |
| **Click + drag on In handle** (±8 px) | Move only the In boundary; Out stays fixed |
| **Click + drag on Out handle** (±8 px) | Move only the Out boundary; In stays fixed |
| **Click** (drag < 0.5 s) | Clear the punch region and reset loop toggle |
| **⟳ button** (right edge of ruler) | Toggle region loop on/off |

The cursor changes to `ew-resize` when hovering over a handle and `crosshair` elsewhere. The ruler and track overlays are read-only during recording.

Punch state in the player store (memory only, not persisted):

| Field | Type | Meaning |
|-------|------|---------|
| `punchIn` | `number \| null` | Region start (seconds) |
| `punchOut` | `number \| null` | Region end (seconds) |
| `punchLoop` | `boolean` | Loop the region during playback |

### Playback with a Punch Region

When `punchIn` is set, pressing **Play** always seeks to `punchIn` first (`togglePlay` routes through the store `play()` action so the seek always applies).

`onTimeUpdate` handles what happens when `punchOut` is reached:

```ts
if (punchOut !== null && time >= punchOut) {
  if (isRecording)       → stopRecording()           // save take
  else if (punchLoop)    → eng.seekTo(punchIn)        // loop: jump back
  else                   → pause + seekTo(punchIn)    // stop and rewind
}
```

## startRecording Sequence

```
1. recordingStartPos = punchIn ?? currentTime  use punch-in if set
2. eng.pause()                          pause playback
3. rec.init(selectedDeviceId)           getUserMedia — mic opens here
4. Enumerate output devices             find real hardware output
5. eng.setOutputDevice(outputId)        pin audio away from Communications endpoint
6. eng.setInteract(false)              lock waveform click-to-seek
7. eng.seekTo(recordingStartPos)        rewind to start (or punch-in) position
8. eng.play()                           start playback (vocals + instrumental both audible)
9. rec.start()                          start MediaRecorder
```

`getUserMedia` must be called **before** `eng.play()`. On Windows WASAPI, opening the mic reconfigures the audio session; if playback is already running it can cause `NotReadableError`.

The singer hears **both** original vocals and instrumental during recording — volumes are individually controlled via the Vocals and Instrumental sliders. There is no mic monitoring passthrough (hardware direct-monitoring on the audio interface is recommended instead).

### Punch-out Boundary Check

`loadSong` wires an `onTimeUpdate` check at ~30 fps. `eng.stop()` inside `stopRecording` halts the rAF loop so the check cannot double-fire after a recording stop. For the playback-loop case, `eng.seekTo` is synchronous and the next `onTimeUpdate` tick fires at the new position.

## stopRecording Sequence

```
1. eng.stop()                           stop playback, seek to 0
2. eng.setInteract(true)               unlock waveform
3. blob = await rec.stop()             drain MediaRecorder chunks
4. rec.releaseStream()                 stop mic tracks → Windows exits comm mode
5. eng.setOutputDevice(selectedOutput) restore normal output routing
6. saveTake(songId, blob, startPos)    write take to disk via Tauri
7. set state: isRecording=false, activeTakeId=take.id
```

Setting `activeTakeId` triggers the `Waveform` component to call `eng.loadTakeTrack()`, which loads the take as a third, separate waveform track alongside vocals and instrumental.

## Windows WASAPI: Default Communications Device

Windows maintains two "default" audio endpoints:

- **Default Device** — used for music, games, normal audio
- **Default Communications Device** — used for voice calls, WebRTC

When `getUserMedia` opens a microphone, Windows silently switches the `""` sinkId alias to point to the **Communications** endpoint. In most setups this is a different physical port than regular speakers/headphones, causing silence during recording.

### Auto-detection of Real Output

After `getUserMedia`, the store enumerates output devices and picks the real hardware output:

1. **Filter out aliases** — exclude labels starting with `"Default -"` or `"Communications -"` and virtual devices (e.g., Steam Streaming Speakers)
2. **Match mic interface** — prefer the output whose label shares a token ≥4 characters with the selected microphone label (e.g., `"BEHRINGER"` in both `"Line In (2-Behringer USB WDM Audio)"` and `"Speakers (2-Behringer USB WDM Audio)"`)
3. **Fallback** — first non-alias, non-virtual output if no match found
4. **User override** — if `selectedOutputDeviceId` is set explicitly, it takes priority

### Releasing Communication Mode

After recording, `rec.releaseStream()` stops all mic tracks:

```ts
releaseStream(): void {
  this.stream?.getTracks().forEach((t) => t.stop());
  this.stream = null;
}
```

Stopping mic tracks signals Windows to exit communication mode and restore the `""` sinkId alias back to the Default Device. `setOutputDevice("")` is then called to flush any pinned sinkId from the audio elements.

## Seek Lock During Recording

DAWs (e.g., Cakewalk) prevent the user from repositioning the playhead while recording to guarantee sync. VPS does the same via two mechanisms:

1. `eng.setInteract(false)` — disables WaveSurfer waveform click-to-seek
2. `if (get().isRecording) return` guard in the Zustand `seek` action

The stop button is also rerouted during recording:

```tsx
// TransportControls.tsx
<button onClick={isRecording ? () => void stopRecording() : stop}>
```

## startPosition Field

When recording begins at a non-zero position, `recordingStartPos` is saved. It is passed to `saveTake` and stored on the `Take` as `startPosition`. The audio engine uses this offset when playing back the take to align it with the instrumental — see `_takeOffset` in [Audio Engine](audio-engine.md).

## MediaRecorder Codec Fallback

WebView2 may not support `audio/webm;codecs=opus`. The recorder tries codecs in order:

```ts
const mimeType = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
].find((t) => MediaRecorder.isTypeSupported(t)) ?? "";
```

If none are supported, `MediaRecorder` is created without an explicit `mimeType` and uses the browser default.

## Auto-stop on Song End

When the instrumental finishes (`"finish"` event), the engine fires the `_finishCb`. The store checks `isRecording` and calls `stopRecording()` automatically, so the take is saved even if the singer doesn't click stop.
