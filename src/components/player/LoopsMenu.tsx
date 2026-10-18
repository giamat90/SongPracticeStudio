import { useEffect, useMemo, useState } from "react";
import { formatLoopClock, useLoopsMenu } from "@giamat90/mps-core/hooks";
import { usePlayerStore } from "../../stores/player";
import { readSongChords } from "../../lib/tauri";
import { detectSections } from "../../lib/sections";
import type { ChordSegment } from "../../lib/types";

/** The song's sections as the chords tell them: SPS-only, because VPS has no chords. */
function useChordSections(open: boolean) {
  const song = usePlayerStore((s) => s.song);
  const duration = usePlayerStore((s) => s.duration);
  const metronomeOffset = usePlayerStore((s) => s.metronomeOffset);
  const chordsRevision = usePlayerStore((s) => s.chordsRevision);
  const [chords, setChords] = useState<ChordSegment[]>([]);
  const hasChords = song?.hasChords ?? false;
  const songId = song?.id;

  useEffect(() => {
    if (!open || !hasChords || !songId) return;
    let cancelled = false;
    readSongChords(songId)
      .then((segments) => { if (!cancelled) setChords(segments); })
      .catch((e: unknown) => console.error("[LoopsMenu] readSongChords failed:", e));
    return () => { cancelled = true; };
  }, [open, hasChords, songId, chordsRevision]);

  const detected = useMemo(
    () => detectSections(chords, { duration, bpm: song?.detectedBpm ?? 0, offset: metronomeOffset }),
    [chords, duration, song?.detectedBpm, metronomeOffset],
  );
  return { hasChords, detected };
}

/** Saved named loops of the song, and the song cut into groups of bars, each one click from looping. */
export default function LoopsMenu() {
  const menu = useLoopsMenu(usePlayerStore);
  const { hasChords, detected } = useChordSections(menu.open);

  if (!menu.available) return null;

  return (
    <div className="panel-menu loops-menu" ref={menu.rootRef}>
      <button
        type="button"
        className={`panel-menu__button${menu.open ? " panel-menu__button--active" : ""}`}
        onClick={menu.toggle}
        aria-expanded={menu.open}
        title="Saved loops and bar sections"
      >
        {`Loops${menu.loops.length > 0 ? ` (${menu.loops.length})` : ""} ▾`}
      </button>
      {menu.open && (
        <div className="panel-menu__popover loops-menu__popover" role="group" aria-label="Loops">
          <h3 className="loops-menu__heading">Saved loops</h3>
          {menu.loops.length === 0 ? (
            <p className="loops-menu__empty">None yet. Drag a region on the ruler, then save it below.</p>
          ) : (
            <ul className="loops-menu__list">
              {menu.loops.map((l) => (
                <li key={l.id} className="loops-menu__row">
                  {menu.renaming?.id === l.id ? (
                    <input
                      className="loops-menu__input"
                      value={menu.renaming.value}
                      autoFocus
                      aria-label="Loop name"
                      onChange={(e) => menu.setRenamingValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void menu.commitRename();
                        else if (e.key === "Escape") menu.cancelRename();
                      }}
                      onBlur={() => void menu.commitRename()}
                    />
                  ) : (
                    <button
                      type="button"
                      className="loops-menu__apply"
                      onClick={() => menu.apply(l.start, l.end)}
                      disabled={menu.isRecording}
                      title={`Loop ${formatLoopClock(l.start)} to ${formatLoopClock(l.end)}`}
                    >
                      <span className="loops-menu__name">{l.name}</span>
                      <span className="loops-menu__time">{formatLoopClock(l.start)}–{formatLoopClock(l.end)}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="loops-menu__icon"
                    onClick={() => menu.startRename(l)}
                    title="Rename loop"
                    aria-label={`Rename ${l.name}`}
                  >
                    &#9998;
                  </button>
                  <button
                    type="button"
                    className="loops-menu__icon"
                    onClick={() => void menu.remove(l.id)}
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
              value={menu.name}
              placeholder={`Loop ${menu.loops.length + 1}`}
              aria-label="Name for the new loop"
              disabled={!menu.hasRegion}
              onChange={(e) => menu.setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void menu.save();
              }}
            />
            <button
              type="button"
              className="loops-menu__button"
              onClick={() => void menu.save()}
              disabled={!menu.hasRegion}
              title={menu.hasRegion ? "Save the punch region under this name" : "Set a punch region first"}
            >
              Save region
            </button>
          </div>
          {menu.message && <p className="loops-menu__message" role="alert">{menu.message}</p>}

          {hasChords && (
            <>
              <h3 className="loops-menu__heading">Sections from the chords</h3>
              {detected.length === 0 ? (
                <p className="loops-menu__empty">Not enough chord changes to tell sections apart.</p>
              ) : (
                <ul className="loops-menu__list loops-menu__sections">
                  {detected.map((s) => (
                    <li key={s.start} className="loops-menu__row">
                      <button
                        type="button"
                        className="loops-menu__apply"
                        onClick={() => menu.apply(s.start, s.end)}
                        disabled={menu.isRecording}
                      >
                        <span className="loops-menu__name">{s.label === "Intro" ? "Intro" : `Section ${s.label}`}</span>
                        <span className="loops-menu__time">{formatLoopClock(s.start)}–{formatLoopClock(s.end)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          <h3 className="loops-menu__heading">
            Bars
            <select
              className="loops-menu__select"
              value={menu.sectionBars}
              onChange={(e) => menu.setSectionBars(Number(e.target.value))}
              aria-label="Bars per section"
            >
              {menu.sectionSizes.map((n) => (
                <option key={n} value={n}>{n} bars</option>
              ))}
            </select>
          </h3>
          {menu.sections.length === 0 ? (
            <p className="loops-menu__empty">Needs a detected tempo.</p>
          ) : (
            <ul className="loops-menu__list loops-menu__sections">
              {menu.sections.map((s) => (
                <li key={s.start} className="loops-menu__row">
                  <button
                    type="button"
                    className="loops-menu__apply"
                    onClick={() => menu.apply(s.start, s.end)}
                    disabled={menu.isRecording}
                  >
                    <span className="loops-menu__name">{s.label}</span>
                    <span className="loops-menu__time">{formatLoopClock(s.start)}–{formatLoopClock(s.end)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="loops-menu__hint">Sections follow where the chord progression changes, in blocks of four bars; sections with the same letter play the same chords. Bars are counted from the metronome downbeat, four beats to a bar.</p>
        </div>
      )}
    </div>
  );
}
