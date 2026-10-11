import { useEffect, useRef, useState } from "react";
import { barSections } from "@giamat90/mps-core/loops";
import { usePlayerStore } from "../../stores/player";

const SECTION_SIZES = [2, 4, 8, 16];
const BEATS_PER_BAR = 4;

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Saved named loops of the song, and the song cut into groups of bars, each one click from looping. */
export default function LoopsMenu() {
  const song = usePlayerStore((s) => s.song);
  const punchIn = usePlayerStore((s) => s.punchIn);
  const punchOut = usePlayerStore((s) => s.punchOut);
  const duration = usePlayerStore((s) => s.duration);
  const metronomeOffset = usePlayerStore((s) => s.metronomeOffset);
  const isRecording = usePlayerStore((s) => s.isRecording);
  const saveLoop = usePlayerStore((s) => s.saveLoop);
  const renameLoop = usePlayerStore((s) => s.renameLoop);
  const deleteLoop = usePlayerStore((s) => s.deleteLoop);
  const applyLoopRegion = usePlayerStore((s) => s.applyLoopRegion);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [sectionBars, setSectionBars] = useState(4);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (!song) return null;

  const loops = song.loops ?? [];
  const hasRegion = punchIn !== null && punchOut !== null;
  const sections = barSections({
    duration,
    bpm: song.detectedBpm ?? 0,
    beatsPerBar: BEATS_PER_BAR,
    offset: metronomeOffset,
    barsPerSection: sectionBars,
  });

  const attempt = async (action: () => Promise<void>) => {
    setMessage(null);
    try {
      await action();
    } catch (e) {
      console.error("[LoopsMenu] loop change failed:", e);
      setMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const handleSave = () =>
    attempt(async () => {
      await saveLoop(name.trim() === "" ? `Loop ${loops.length + 1}` : name);
      setName("");
    });

  const handleRename = () =>
    attempt(async () => {
      if (!renaming) return;
      await renameLoop(renaming.id, renaming.value);
      setRenaming(null);
    });

  return (
    <div className="panel-menu loops-menu" ref={root}>
      <button
        type="button"
        className={`panel-menu__button${open ? " panel-menu__button--active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Saved loops and bar sections"
      >
        {`Loops${loops.length > 0 ? ` (${loops.length})` : ""} ▾`}
      </button>
      {open && (
        <div className="panel-menu__popover loops-menu__popover" role="group" aria-label="Loops">
          <h3 className="loops-menu__heading">Saved loops</h3>
          {loops.length === 0 ? (
            <p className="loops-menu__empty">None yet. Drag a region on the ruler, then save it below.</p>
          ) : (
            <ul className="loops-menu__list">
              {loops.map((l) => (
                <li key={l.id} className="loops-menu__row">
                  {renaming?.id === l.id ? (
                    <input
                      className="loops-menu__input"
                      value={renaming.value}
                      autoFocus
                      aria-label="Loop name"
                      onChange={(e) => setRenaming({ id: l.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void handleRename();
                        else if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => void handleRename()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="loops-menu__apply"
                      onClick={() => applyLoopRegion(l.start, l.end)}
                      disabled={isRecording}
                      title={`Loop ${formatClock(l.start)} to ${formatClock(l.end)}`}
                    >
                      <span className="loops-menu__name">{l.name}</span>
                      <span className="loops-menu__time">{formatClock(l.start)}–{formatClock(l.end)}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="loops-menu__icon"
                    onClick={() => setRenaming({ id: l.id, value: l.name })}
                    title="Rename loop"
                    aria-label={`Rename ${l.name}`}
                  >
                    &#9998;
                  </button>
                  <button
                    type="button"
                    className="loops-menu__icon"
                    onClick={() => void attempt(() => deleteLoop(l.id))}
                    title="Delete loop"
                    aria-label={`Delete ${l.name}`}
                  >
                    &times;
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="loops-menu__save">
            <input
              className="loops-menu__input"
              value={name}
              placeholder={`Loop ${loops.length + 1}`}
              aria-label="Name for the new loop"
              disabled={!hasRegion}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleSave();
              }}
            />
            <button
              type="button"
              className="loops-menu__button"
              onClick={() => void handleSave()}
              disabled={!hasRegion}
              title={hasRegion ? "Save the punch region under this name" : "Set a punch region first"}
            >
              Save region
            </button>
          </div>
          {message && <p className="loops-menu__message" role="alert">{message}</p>}

          <h3 className="loops-menu__heading">
            Bars
            <select
              className="loops-menu__select"
              value={sectionBars}
              onChange={(e) => setSectionBars(Number(e.target.value))}
              aria-label="Bars per section"
            >
              {SECTION_SIZES.map((n) => (
                <option key={n} value={n}>{n} bars</option>
              ))}
            </select>
          </h3>
          {sections.length === 0 ? (
            <p className="loops-menu__empty">Needs a detected tempo.</p>
          ) : (
            <ul className="loops-menu__list loops-menu__sections">
              {sections.map((s) => (
                <li key={s.start} className="loops-menu__row">
                  <button
                    type="button"
                    className="loops-menu__apply"
                    onClick={() => applyLoopRegion(s.start, s.end)}
                    disabled={isRecording}
                  >
                    <span className="loops-menu__name">{s.label}</span>
                    <span className="loops-menu__time">{formatClock(s.start)}–{formatClock(s.end)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="loops-menu__hint">Counted from the metronome downbeat, four beats to a bar.</p>
        </div>
      )}
    </div>
  );
}
