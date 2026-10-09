import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent, type RefCallback } from "react";
import { usePlayerStore, getEngine, TAKE_TRACK_KEY } from "../../stores/player";
import { exportTake } from "../../lib/tauri";
import type { Song, Take } from "../../lib/types";

// Chunk-based alternative to dragging: fine enough to correct residual sync
// error left after latency calibration (perceptible misalignment starts
// around 20-30ms), without needing many presses for larger corrections.
const TAKE_NUDGE_STEP_S = 0.01;
const TAKE_NUDGE_COARSE_MULTIPLIER = 5; // Shift+Arrow = 50ms

function PunchOverlay() {
  const punchIn     = usePlayerStore((s) => s.punchIn);
  const punchOut    = usePlayerStore((s) => s.punchOut);
  const duration    = usePlayerStore((s) => s.duration);
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const scrollTime  = usePlayerStore((s) => s.scrollTime);
  if (punchIn === null || punchOut === null || duration <= 0) return null;
  return (
    <div
      className="waveform__punch-overlay"
      style={{
        left:  `${(punchIn - scrollTime) * minPxPerSec}px`,
        width: `${(punchOut - punchIn) * minPxPerSec}px`,
      }}
    />
  );
}

// Drag handle for manually nudging the take's sync position; commits a
// 0.1s-rounded offset on release. Uses pointer capture (not plain mouse
// events) since this is a small element and the drag needs to keep tracking
// even once the cursor leaves it.
// Unclamped in both directions — dragging left of song time 0 is allowed
// (the leading part of the take before song time 0 just isn't reachable
// during playback; the recorded file itself is never trimmed or modified).
function TakeSyncControls({ take }: { take: Take }) {
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const setTakeManualOffset = usePlayerStore((s) => s.setTakeManualOffset);
  const dragRef = useRef<{ startX: number; startOffset: number; dragging: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);
  const offsetMs = Math.round((take.manualOffset ?? 0) * 1000);
  // Editable offset field: lets the user jump straight to a rough value (e.g.
  // type 300 for a ~300ms drift) instead of nudging up from 0, then fine-tune
  // with the nudge buttons/arrow keys from there. Local text state so partial
  // input (e.g. a lone "-") doesn't get clobbered by the next store-derived
  // render; only re-synced from the store while the field isn't focused.
  const [offsetInput, setOffsetInput] = useState(String(offsetMs));
  const inputFocused = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) setOffsetInput(String(offsetMs));
  }, [offsetMs]);

  const commitOffsetInput = () => {
    const parsedMs = Number(offsetInput);
    if (Number.isFinite(parsedMs)) {
      setTakeManualOffset(take.id, parsedMs / 1000);
    } else {
      setOffsetInput(String(offsetMs));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startOffset: take.manualOffset ?? 0, dragging: false };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const deltaPx = e.clientX - d.startX;
    if (!d.dragging) {
      if (Math.abs(deltaPx) < 3) return;
      d.dragging = true;
      setDragging(true);
    }
    const newOffset = d.startOffset + deltaPx / minPxPerSec;
    getEngine().setTakeManualOffset(newOffset);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragging(false);
    if (!d || !d.dragging) return;
    const deltaPx = e.clientX - d.startX;
    const newOffset = d.startOffset + deltaPx / minPxPerSec;
    setTakeManualOffset(take.id, newOffset);
  };

  const nudge = (direction: 1 | -1, coarse: boolean) => {
    const step = TAKE_NUDGE_STEP_S * (coarse ? TAKE_NUDGE_COARSE_MULTIPLIER : 1) * direction;
    setTakeManualOffset(take.id, (take.manualOffset ?? 0) + step);
  };

  // Scoped (not global) so arrow keys only nudge while this control has
  // focus — click it or Tab to it. Avoids claiming the arrow keys app-wide
  // since there's no other keyboard shortcut in the app yet to coordinate with.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    nudge(e.key === "ArrowLeft" ? -1 : 1, e.shiftKey);
  };

  return (
    <div
      className="waveform__take-sync"
      tabIndex={0}
      role="group"
      aria-label="Take sync offset"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className={`waveform__take-drag${dragging ? " waveform__take-drag--active" : ""}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title="Drag to nudge take into sync with the other tracks"
      >
        ⠿
      </button>
      <button
        type="button"
        className="waveform__take-nudge"
        onClick={() => nudge(-1, false)}
        title="Nudge 10ms earlier (Shift: 50ms). Click here first, then use ←/→ arrow keys."
      >
        ◀
      </button>
      <input
        type="number"
        step={10}
        className="waveform__take-offset"
        value={offsetInput}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setOffsetInput(e.target.value)}
        onFocus={(e: FocusEvent<HTMLInputElement>) => {
          inputFocused.current = true;
          e.target.select();
        }}
        onBlur={() => {
          inputFocused.current = false;
          commitOffsetInput();
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          // Stop the container's arrow-nudge handler from firing while typing —
          // arrow keys here should move the text cursor / number step, not nudge.
          e.stopPropagation();
          if (e.key === "Enter") {
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            setOffsetInput(String(offsetMs));
            e.currentTarget.blur();
          }
        }}
        title="Take offset in milliseconds — type a value (e.g. 300) and press Enter to jump there, then fine-tune with the nudge buttons or arrow keys"
        aria-label="Take offset in milliseconds"
      /><span className="waveform__take-offset-unit">ms</span>
      <button
        type="button"
        className="waveform__take-nudge"
        onClick={() => nudge(1, false)}
        title="Nudge 10ms later (Shift: 50ms). Click here first, then use ←/→ arrow keys."
      >
        ▶
      </button>
      <button
        type="button"
        className="waveform__take-reset"
        disabled={!take.manualOffset}
        onClick={() => setTakeManualOffset(take.id, 0)}
        title="Reset to auto-detected position"
        aria-label="Reset to auto-detected position"
      >
        ↺
      </button>
    </div>
  );
}

interface TakeTrackProps {
  take: Take;
  song: Song;
  containerRef: RefCallback<HTMLDivElement>;
}

function TakeTrack({ take, song, containerRef }: TakeTrackProps) {
  const volume        = usePlayerStore((s) => s.takeVolume);
  const setTakeVolume  = usePlayerStore((s) => s.setTakeVolume);
  const isMuted        = usePlayerStore((s) => !!s.mutedStems[TAKE_TRACK_KEY]);
  const soloedStem     = usePlayerStore((s) => s.soloedStem);
  const isSoloed       = soloedStem === TAKE_TRACK_KEY;
  const toggleMute     = usePlayerStore((s) => s.toggleMute);
  const toggleSolo     = usePlayerStore((s) => s.toggleSolo);
  const [isExporting, setIsExporting] = useState(false);

  const label = take.name || "Take";

  const handleDownload = async () => {
    setIsExporting(true);
    try {
      await exportTake(take.filepath, `${song.title} - ${label}.wav`);
    } catch (e) {
      console.error("[TakeTrack] export failed:", e);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="stem-track">
      <div className="stem-track__header">
        <span className="stem-track__label waveform__label--take">🎙 {label}</span>
        <div className="stem-track__controls">
          <TakeSyncControls take={take} />
          <button
            className={`stem-track__mute${isMuted ? " stem-track__mute--on" : ""}`}
            onClick={() => toggleMute(TAKE_TRACK_KEY)}
            title={isMuted ? "Unmute" : "Mute"}
            aria-label={isMuted ? "Unmute" : "Mute"}
          >
            M
          </button>
          <button
            className={`stem-track__solo${isSoloed ? " stem-track__solo--on" : ""}`}
            onClick={() => toggleSolo(TAKE_TRACK_KEY)}
            title={isSoloed ? "Unsolo" : "Solo"}
            aria-label={isSoloed ? "Unsolo" : "Solo"}
          >
            S
          </button>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => setTakeVolume(Number(e.target.value))}
            className="stem-track__volume"
            title="Take volume"
          />
          <button
            className="stem-track__download"
            onClick={handleDownload}
            disabled={isExporting}
            title={`Download ${label}`}
            aria-label={`Download ${label}`}
          >
            {isExporting ? "…" : "↓"}
          </button>
        </div>
      </div>
      <div className="stem-track__body waveform__take-rail">
        <div ref={containerRef} />
        <PunchOverlay />
      </div>
    </div>
  );
}

export default TakeTrack;
