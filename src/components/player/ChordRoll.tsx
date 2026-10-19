import { useEffect, useMemo, useRef, useState } from "react";
import ChordSpectrumPanel from "./ChordSpectrumPanel";
import { readChordTuning, saveChordEdits } from "../../lib/tauri";
import { addChordAt, setChordAt, setChordStart } from "../../lib/chordEdit";
import { ADD_HALF_PX, STRIP_H, classifyPress, type RollBlock } from "../../lib/rollHit";
import { useChordSelection } from "../../stores/chordSelection";
import ChordEditorHost from "./ChordEditorHost";
import { useNoteRoll } from "./useNoteRoll";
import { useChordCommit } from "./useChordCommit";
import { chordSynth } from "../../audio/chordSynth";
import { getEngine, usePlayerStore } from "../../stores/player";
import { STEM_COLORS } from "../../audio/engine";
import { formatChordName, isUnsure, shiftSegment, useChordSegments } from "../../lib/chords";
import { MIDI_HIGH, MIDI_LOW, chordPitchClasses, noteStrength } from "../../lib/noteRoll";
import type { Song } from "../../lib/types";

const WINDOW_S = 10;
const KEYS_W = 34;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** The roll leaves these to the chord detector's own view: drums have no notes. */
const NOT_NOTES = new Set(["drums"]);
const LIT = 120;
/** Energy on a note the chord does not have is drawn this much fainter when the fade is on. */
const OFF_CHORD_FADE = 0.45;
/** A press that moves less than this is a click, not a drag. */
const CLICK_PX = 3;

type Drag =
  | { kind: "add"; startX: number; moved: boolean }
  | { kind: "seek"; startX: number; startTime: number; moved: boolean; pick: number | null }
  | { kind: "edge"; index: number; time: number; startX: number; moved: boolean };
/** Lowest and highest note the roll can be set to show: bass guitar's low E up to a guitar's top. */
const LOW_OPTIONS = [28, 36, 48];
const HIGH_OPTIONS = [60, 72, 84, 88];

interface ChipState {
  active: boolean;
  selected: boolean;
  hover: boolean;
  unsure: boolean;
}

/** One chord of the strip as a button: rounded, the name centred in it, brighter when it is the chord playing, hovered or picked. */
function drawChip(ctx: CanvasRenderingContext2D, x0: number, x1: number, name: string, state: ChipState) {
  const x = x0 + 2;
  const w = x1 - x0 - 4;
  if (w < 6) return;
  const y = 3;
  const h = STRIP_H - 6;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 4);
  ctx.fillStyle = state.selected ? "rgba(245,158,11,0.7)"
    : state.active ? "rgba(245,158,11,0.45)"
    : state.hover ? "rgba(245,158,11,0.32)"
    : "rgba(245,158,11,0.18)";
  ctx.fill();
  ctx.strokeStyle = state.selected ? "#ffffff" : "rgba(245,158,11,0.55)";
  ctx.lineWidth = state.selected ? 1.5 : 1;
  ctx.stroke();
  if (w < 22) return;
  let label = name;
  while (label.length > 1 && ctx.measureText(label).width > w - 6) label = label.slice(0, -1);
  ctx.fillStyle = state.unsure ? "rgba(255,247,230,0.6)" : "#fff7e6";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + w / 2, y + h / 2 + 0.5);
  ctx.textAlign = "left";
}

/** The "+" in the strip, at the playhead, offered while the playhead is in a stretch with no chord. */
function drawAdd(ctx: CanvasRenderingContext2D, x: number) {
  const w = ADD_HALF_PX * 2;
  const h = STRIP_H - 6;
  ctx.beginPath();
  ctx.roundRect(x - ADD_HALF_PX, 3, w, h, 4);
  ctx.fillStyle = "rgba(245,158,11,0.12)";
  ctx.fill();
  ctx.setLineDash([3, 2]);
  ctx.strokeStyle = "rgba(245,158,11,0.8)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff7e6";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("+", x, 3 + h / 2 + 0.5);
  ctx.textAlign = "left";
}

const midiName = (midi: number) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;

function rgba(color: string, alpha: number): string {
  return color.replace(/[\d.]+\)$/, `${alpha})`);
}

const PREFS_KEY = "sps_chord_roll_views";
interface Prefs {
  roll: boolean;
  spectrum: boolean;
  low: number;
  high: number;
  fade: boolean;
}
const DEFAULT_PREFS: Prefs = { roll: true, spectrum: true, low: 28, high: 72, fade: true };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null") as Partial<Prefs> | null;
    return {
      roll: raw?.roll !== false,
      spectrum: raw?.spectrum !== false,
      low: LOW_OPTIONS.includes(raw?.low ?? -1) ? raw!.low! : DEFAULT_PREFS.low,
      high: HIGH_OPTIONS.includes(raw?.high ?? -1) ? raw!.high! : DEFAULT_PREFS.high,
      fade: raw?.fade !== false,
    };
  } catch (e) {
    console.warn("[ChordRoll] could not read the saved settings:", e);
    return DEFAULT_PREFS;
  }
}

interface RollProps {
  song: Song;
}

export default function ChordRoll({ song }: RollProps) {
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [error, setError] = useState<string | null>(null);
  const transpose = usePlayerStore((s) => s.transpose);
  const capo = usePlayerStore((s) => s.capo);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const { stored, segments, display, centerIndex } = useChordSegments(song);
  const [tuningCents, setTuningCents] = useState(0);
  const candidate = useChordSelection((s) => s.candidate);
  const editing = useChordCommit(song);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  /** The chords in view and where they span on the canvas, left by the last frame drawn. */
  const blocks = useRef<RollBlock[]>([]);
  const hover = useRef<number | null>(null);
  /** Where the "+" is on the canvas while there is one to press, left by the last frame drawn. */
  const addAt = useRef<number | null>(null);
  const selected = useChordSelection((s) => s.index);
  const noteStems = useMemo(() => song.stems.filter((s) => !NOT_NOTES.has(s)), [song.stems]);
  const roll = useNoteRoll(song, noteStems, prefs.roll);
  const live = useRef({ matrices: roll.matrices, ticked, stored, names: display, transpose, shift: 0, playing: isPlaying, prefs, selected });
  live.current = {
    matrices: roll.matrices, ticked, stored, names: display, transpose, shift: transpose - roll.analysedAt,
    playing: isPlaying, prefs, selected,
  };

  useEffect(() => {
    if (!song.hasChords) return;
    let cancelled = false;
    readChordTuning(song.id)
      .then((cents) => { if (!cancelled) setTuningCents(cents); })
      .catch((e: unknown) => console.error("[ChordRoll] readChordTuning failed:", e));
    return () => { cancelled = true; };
  }, [song.id, song.hasChords, revision]);

  const spectrumSource = useMemo(() => ({
    stems: song.stems,
    samples: (names: readonly string[], from: number, to: number) => getEngine().getStemSamples(names, from, to),
  }), [song.stems]);

  useEffect(() => {
    useChordSelection.getState().clear();
  }, [song.id]);

  useEffect(() => {
    setTicked(Object.fromEntries(noteStems.map((s) => [s, s !== "vocals"])));
  }, [song.id, noteStems]);

  const setPref = <K extends keyof Prefs>(key: K, value: Prefs[K]) => {
    const next = { ...prefs, [key]: value };
    setPrefs(next);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn("[ChordRoll] could not save the settings:", e);
    }
  };

  const rollGeometry = (el: HTMLCanvasElement) => ({ left: el.getBoundingClientRect().left, top: el.getBoundingClientRect().top, rollW: el.offsetWidth - KEYS_W });
  const timeAt = (el: HTMLCanvasElement, x: number) =>
    getEngine().getCurrentTime() - WINDOW_S / 2 + ((x - KEYS_W) / rollGeometry(el).rollW) * WINDOW_S;
  const seekTo = (time: number) => usePlayerStore.getState().seek(Math.min(Math.max(time, 0), song.duration));

  const commitEdge = async (index: number, time: number) => {
    setError(null);
    try {
      await saveChordEdits(song.id, setChordStart(live.current.stored, index, time));
      usePlayerStore.getState().bumpChordsRevision();
    } catch (e) {
      console.error("[ChordRoll] moving the chord edge failed:", e);
      setError(String(e));
    }
  };

  const addChord = async () => {
    const at = getEngine().getCurrentTime();
    const previous = [...live.current.stored].reverse().find((seg) => seg.end <= at);
    const added = addChordAt(live.current.stored, at, previous?.chord ?? "C:maj", song.duration);
    if (!added) {
      setError("There is no room for a chord here.");
      return;
    }
    setError(null);
    try {
      await saveChordEdits(song.id, added.segments);
      usePlayerStore.getState().bumpChordsRevision();
      useChordSelection.getState().select(added.index);
    } catch (e) {
      console.error("[ChordRoll] adding a chord failed:", e);
      setError(String(e));
    }
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const { left, top } = rollGeometry(el);
    const x = e.clientX - left;
    if (e.button !== 0 || x < KEYS_W) return;
    el.setPointerCapture(e.pointerId);
    const press = classifyPress(blocks.current, x, e.clientY - top, addAt.current);
    if (press.kind === "add") drag.current = { kind: "add", startX: x, moved: false };
    else if (press.kind === "edge") drag.current = { kind: "edge", index: press.index, time: timeAt(el, x), startX: x, moved: false };
    else drag.current = { kind: "seek", startX: x, startTime: getEngine().getCurrentTime(), moved: false, pick: press.kind === "strip" ? press.index : null };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const { left, top, rollW } = rollGeometry(el);
    const x = e.clientX - left;
    const held = drag.current;
    if (!held) {
      const press = classifyPress(blocks.current, x, e.clientY - top, addAt.current);
      el.style.cursor = press.kind === "edge" ? "ew-resize" : press.kind === "strip" || press.kind === "add" ? "pointer" : "";
      hover.current = press.kind === "strip" ? press.index : null;
      return;
    }
    if (Math.abs(x - held.startX) > CLICK_PX) held.moved = true;
    if (held.kind === "edge") held.time = timeAt(el, x);
    else if (held.kind === "seek" && held.moved) seekTo(held.startTime - ((x - held.startX) / rollW) * WINDOW_S);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const el = e.currentTarget;
    const held = drag.current;
    drag.current = null;
    if (!held) return;
    if (held.kind === "add") {
      if (!held.moved) void addChord();
    } else if (held.kind === "edge") {
      if (held.moved) void commitEdge(held.index, held.time);
      else useChordSelection.getState().toggle(held.index);
    } else if (!held.moved) {
      if (held.pick !== null) useChordSelection.getState().toggle(held.pick);
      else seekTo(timeAt(el, e.clientX - rollGeometry(el).left));
    }
  };

  useEffect(() => {
    if (!prefs.roll) return;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const el = canvas.current;
      const ctx = el?.getContext("2d");
      if (!el || !ctx) return;
      const W = el.offsetWidth || 600;
      const H = el.offsetHeight || 260;
      if (el.width !== W || el.height !== H) {
        el.width = W;
        el.height = H;
      }
      const { matrices: m, ticked: on, stored: segs, names, transpose: tr, shift, playing, prefs: p, selected: picked } = live.current;
      const low = p.low;
      const high = p.high;
      const now = getEngine().getCurrentTime();
      const t0 = now - WINDOW_S / 2;
      const rows = high - low + 1;
      const rowH = (H - STRIP_H) / rows;
      const rollW = W - KEYS_W;
      const xOf = (t: number) => KEYS_W + ((t - t0) / WINDOW_S) * rollW;
      const yOf = (midi: number) => H - (midi - low + 1) * rowH;

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);
      for (let midi = low; midi <= high; midi++) {
        ctx.fillStyle = BLACK.has(midi % 12) ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.055)";
        ctx.fillRect(KEYS_W, yOf(midi), rollW, rowH - 0.5);
      }

      // The chords in view and the lanes of their notes: a tinted band and a line under the energy, a tab at the chord's start over it.
      const chords = segs
        .map((s, index) => ({ seg: shiftSegment(s, tr), index }))
        .filter(({ seg }) => seg.end > t0 && seg.start < t0 + WINDOW_S)
        .map(({ seg, index }) => ({ seg, index, pcs: chordPitchClasses(seg.chord, seg.bass) }));
      blocks.current = chords.map(({ seg, index }) => ({ index, x0: xOf(seg.start), x1: xOf(seg.end) }));
      for (const { seg, pcs } of chords) {
        const x0 = Math.max(KEYS_W, xOf(seg.start));
        const x1 = Math.min(W, xOf(seg.end));
        ctx.fillStyle = "rgba(217,119,6,0.07)";
        ctx.fillRect(x0, STRIP_H, x1 - x0, H - STRIP_H);
        for (let midi = low; midi <= high; midi++) {
          if (!pcs.has(midi % 12)) continue;
          ctx.fillStyle = "rgba(245,158,11,0.13)";
          ctx.fillRect(x0, yOf(midi), x1 - x0, rowH - 0.5);
          ctx.fillStyle = "rgba(245,158,11,0.55)";
          ctx.fillRect(x0, yOf(midi) + rowH / 2 - 0.5, x1 - x0, 1);
        }
      }

      ctx.globalCompositeOperation = "lighter";
      const f0 = Math.max(0, Math.floor(t0 / 0.125));
      const f1 = Math.ceil((t0 + WINDOW_S) / 0.125);
      const cellW = (0.125 / WINDOW_S) * rollW + 0.6;
      const chordAt = (t: number) => chords.find(({ seg }) => t >= seg.start && t < seg.end);
      for (const [stem, matrix] of Object.entries(m)) {
        if (!on[stem]) continue;
        const color = STEM_COLORS[stem] ?? STEM_COLORS.other;
        for (let f = f0; f <= f1 && f < matrix.frames; f++) {
          const x = xOf(f * 0.125);
          const inChord = p.fade ? chordAt(f * 0.125 + 0.0625) : undefined;
          for (let midi = Math.max(low, MIDI_LOW); midi <= Math.min(high, MIDI_HIGH); midi++) {
            const v = noteStrength(matrix, f, midi - shift);
            if (v < 25) continue;
            const fade = inChord && inChord.pcs.size > 0 && !inChord.pcs.has(midi % 12) ? OFF_CHORD_FADE : 1;
            ctx.fillStyle = rgba(color, (v / 255) ** 1.6 * 0.95 * fade);
            ctx.fillRect(x, yOf(midi), cellW, rowH - 0.5);
          }
        }
      }

      ctx.globalCompositeOperation = "source-over";
      // The chord strip: a ruler of its own above the notes, one button per chord.
      ctx.fillStyle = "#12122a";
      ctx.fillRect(KEYS_W, 0, rollW, STRIP_H);
      ctx.fillStyle = "rgba(245,158,11,0.25)";
      ctx.fillRect(KEYS_W, STRIP_H - 1, rollW, 1);
      ctx.font = "600 12px sans-serif";
      for (const { seg, pcs, index } of chords) {
        const startX = xOf(seg.start);
        const endX = xOf(seg.end);
        const left = Math.max(KEYS_W, startX);
        const right = Math.min(W, endX);
        if (index === picked) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.strokeRect(left + 0.75, 0.75, right - left - 1.5, H - 1.5);
        }
        drawChip(ctx, left, right, names[index] ? formatChordName(names[index].chord, names[index].bass) : formatChordName(seg.chord, seg.bass), {
          active: now >= seg.start && now < seg.end,
          selected: index === picked,
          hover: index === hover.current,
          unsure: isUnsure(seg),
        });
        ctx.fillStyle = "rgba(245,158,11,0.5)";
        ctx.fillRect(startX, STRIP_H, 1, H - STRIP_H);
        if (startX < KEYS_W) continue;
        ctx.fillStyle = "rgba(251,191,36,0.95)";
        ctx.fillRect(startX - 1.5, 7, 3, STRIP_H - 14);
        for (let midi = low; midi <= high; midi++) {
          if (pcs.has(midi % 12)) ctx.fillRect(startX + 1, yOf(midi) + 1, 3, rowH - 2.5);
        }
      }
      const inChordNow = chords.some(({ seg }) => now >= seg.start && now < seg.end);
      addAt.current = !playing && !inChordNow && now >= 0 && now < song.duration ? xOf(now) : null;
      if (addAt.current !== null) drawAdd(ctx, addAt.current);
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";

      const held = drag.current;
      if (held?.kind === "edge" && held.moved) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(xOf(held.time), 0);
        ctx.lineTo(xOf(held.time), H);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.fillStyle = "#14142a";
      ctx.fillRect(0, 0, KEYS_W, H);
      ctx.fillStyle = "#a0a0b0";
      ctx.textBaseline = "middle";
      ctx.fillText("Chords", 3, STRIP_H / 2);
      ctx.textBaseline = "top";
      const frame = Math.floor(now / 0.125);
      for (let midi = low; midi <= high; midi++) {
        const pc = midi % 12;
        let lit = 0;
        for (const [stem, matrix] of Object.entries(m)) if (on[stem]) lit = Math.max(lit, noteStrength(matrix, frame, midi - shift));
        ctx.fillStyle = lit > LIT ? "#f59e0b" : BLACK.has(pc) ? "#1d1d38" : "#2a2a4a";
        ctx.fillRect(0, yOf(midi), BLACK.has(pc) ? KEYS_W * 0.6 : KEYS_W - 1, rowH - 0.5);
        if (pc === 0) {
          ctx.fillStyle = lit > LIT ? "#1a1a2e" : "#a0a0b0";
          ctx.fillText(midiName(midi), 2, yOf(midi) + rowH / 2 - 5);
        }
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(xOf(now), 0, 1.5, H);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [prefs.roll]);

  if (!song.hasChords) return null;
  // The spectrum looks at the chord being corrected, or at the one under the playhead when none is.
  const picked = selected !== null && selected < segments.length ? selected : null;
  const focus = picked ?? centerIndex;
  const here = focus >= 0 ? segments[focus] : null;
  const tryingChord = candidate && candidate.index === focus ? candidate.chord : here?.chord ?? "C:maj";
  const tryChord = (chord: string) => {
    useChordSelection.getState().setCandidate(focus, chord === here?.chord ? null : chord);
    chordSynth.play({ chord, bass: null, semitones: capo, cents: tuningCents });
  };
  const useBass = (note: string | null) => {
    if (picked === null || !here) return;
    void editing.commit(
      setChordAt(editing.stored, picked, editing.toStored(here.chord), note ? editing.bassToStored(note) : null),
      picked,
    );
  };
  const useChord = (chord: string) => {
    if (picked === null) return;
    void editing.commit(setChordAt(editing.stored, picked, editing.toStored(chord), null), picked);
  };
  const computed = Object.keys(roll.matrices).length > 0;
  const problem = error ?? editing.error ?? roll.error;

  return (
    <section className="chord-roll">
      <header className="chord-roll__head">
        <h2 className="chord-roll__title">Chord roll</h2>
        <span className="chord-roll__views" role="group" aria-label="Views">
          <label><input type="checkbox" checked={prefs.roll} onChange={() => setPref("roll", !prefs.roll)} /> Notes</label>
          <label><input type="checkbox" checked={prefs.spectrum} onChange={() => setPref("spectrum", !prefs.spectrum)} /> Spectrum</label>
        </span>
        {prefs.roll && (
          <span className="chord-roll__views" role="group" aria-label="Notes range">
            <label>
              From{" "}
              <select value={prefs.low} onChange={(e) => setPref("low", Number(e.target.value))}>
                {LOW_OPTIONS.map((m) => <option key={m} value={m}>{midiName(m)}</option>)}
              </select>
            </label>
            <label>
              to{" "}
              <select value={prefs.high} onChange={(e) => setPref("high", Number(e.target.value))}>
                {HIGH_OPTIONS.map((m) => <option key={m} value={m}>{midiName(m)}</option>)}
              </select>
            </label>
            <label title="Draw notes the chord does not have fainter, so the chord's own notes stand out">
              <input type="checkbox" checked={prefs.fade} onChange={() => setPref("fade", !prefs.fade)} /> Fade notes outside the chord
            </label>
          </span>
        )}
        {prefs.roll && roll.status !== null && <span className="chord-roll__progress">{roll.status}</span>}
        {prefs.roll && roll.status === null && (
          <button type="button" onClick={roll.reanalyse} title={computed ? "Analyse the notes again" : "Analyse the notes"}>
            {computed ? "Re-analyse" : "Analyse notes"}
          </button>
        )}
        {prefs.roll && noteStems.map((s) => (
          <label key={s} className="chord-roll__stem" style={{ borderColor: STEM_COLORS[s] }}>
            <input type="checkbox" checked={!!ticked[s]} onChange={() => setTicked({ ...ticked, [s]: !ticked[s] })} />
            {s}
          </label>
        ))}
        {problem && <span className="chord-roll__error">{problem}</span>}
      </header>
      <div className="chord-roll__body">
        {prefs.roll && (
          <canvas
            ref={canvas}
            className="chord-roll__canvas"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; }}
            onPointerLeave={() => { hover.current = null; }}
            title="Click to go there, drag to scrub. Click a chord button to correct it; drag the amber handle at its left to move where it starts"
          />
        )}
        {prefs.spectrum && here ? (
          <div className="chord-roll__spectrum">
            <ChordSpectrumPanel
              key={picked === null ? "playhead" : "stretch"}
              source={spectrumSource}
              start={here.start}
              end={here.end}
              currentTime={currentTime}
              chord={here.chord}
              bass={here.bass ?? null}
              candidate={tryingChord}
              onCandidate={tryChord}
              onUse={picked === null ? undefined : useChord}
              bassNote={picked === null ? null : here.bass ?? null}
              onBass={picked === null ? undefined : useBass}
              soundingOffset={capo}
              tuningCents={tuningCents}
              busy={editing.busy}
              defaultLive={picked === null}
              editor={<ChordEditorHost song={song} />}
            />
          </div>
        ) : (
          <div className="chord-roll__spectrum chord-spectrum">
            <ChordEditorHost song={song} />
          </div>
        )}
      </div>
    </section>
  );
}
