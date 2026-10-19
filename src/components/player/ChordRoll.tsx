import { useEffect, useMemo, useRef, useState } from "react";
import ChordSpectrumPanel from "./ChordSpectrumPanel";
import { readChordTuning } from "../../lib/tauri";
import { getEngine, usePlayerStore } from "../../stores/player";
import { STEM_COLORS } from "../../audio/engine";
import { formatChordName, shiftSegment, useChordSegments } from "../../lib/chords";
import { chordVoicing } from "../../lib/chordVoicing";
import { MIDI_HIGH, MIDI_LOW, computeNoteMatrix, noteStrength, type NoteMatrix } from "../../lib/noteRoll";
import type { Song } from "../../lib/types";

const WINDOW_S = 10;
const KEYS_W = 34;
const SHOWN_LOW = 31;
const SHOWN_HIGH = 72;
const BLACK = new Set([1, 3, 6, 8, 10]);
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
/** The roll leaves these to the chord detector's own view: drums have no notes. */
const NOT_NOTES = new Set(["drums"]);
const LIT = 120;

function rgba(color: string, alpha: number): string {
  return color.replace(/[\d.]+\)$/, `${alpha})`);
}

function chordMidis(chord: string, bass: string | undefined, shift: number): number[] {
  const voicing = chordVoicing(chord, bass, shift);
  if (!voicing) return [];
  return [voicing.bass, ...voicing.upper].map((f) => Math.round(69 + 12 * Math.log2(f / 440)));
}

const VIEWS_KEY = "sps_chord_roll_views";
type Views = { roll: boolean; spectrum: boolean };

function loadViews(): Views {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEWS_KEY) ?? "null") as Partial<Views> | null;
    return { roll: raw?.roll !== false, spectrum: raw?.spectrum !== false };
  } catch (e) {
    console.warn("[ChordRoll] could not read the saved views:", e);
    return { roll: true, spectrum: true };
  }
}

interface RollProps {
  song: Song;
}

export default function ChordRoll({ song }: RollProps) {
  const [open, setOpen] = useState(false);
  const [matrices, setMatrices] = useState<Record<string, NoteMatrix>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [views, setViews] = useState<Views>(loadViews);
  const [error, setError] = useState<string | null>(null);
  const transpose = usePlayerStore((s) => s.transpose);
  const capo = usePlayerStore((s) => s.capo);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const { stored, segments, centerIndex } = useChordSegments(song);
  const [tuningCents, setTuningCents] = useState(0);
  const [tried, setTried] = useState<{ index: number; chord: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ matrices, ticked, stored, transpose });
  live.current = { matrices, ticked, stored, transpose };

  useEffect(() => {
    if (!open || !song.hasChords) return;
    let cancelled = false;
    readChordTuning(song.id)
      .then((cents) => { if (!cancelled) setTuningCents(cents); })
      .catch((e: unknown) => console.error("[ChordRoll] readChordTuning failed:", e));
    return () => { cancelled = true; };
  }, [open, song.id, song.hasChords, revision]);

  const spectrumSource = useMemo(() => ({
    stems: song.stems,
    samples: (names: readonly string[], from: number, to: number) => getEngine().getStemSamples(names, from, to),
  }), [song.stems]);

  const noteStems = useMemo(() => song.stems.filter((s) => !NOT_NOTES.has(s)), [song.stems]);

  useEffect(() => {
    setMatrices({});
    setTicked(Object.fromEntries(noteStems.map((s) => [s, s !== "vocals"])));
  }, [song.id, noteStems]);

  const toggleView = (key: keyof Views) => {
    const next = { ...views, [key]: !views[key] };
    setViews(next);
    try {
      localStorage.setItem(VIEWS_KEY, JSON.stringify(next));
    } catch (e) {
      console.warn("[ChordRoll] could not save the views:", e);
    }
  };

  const compute = async () => {
    setError(null);
    setProgress(0);
    try {
      const out: Record<string, NoteMatrix> = {};
      for (let i = 0; i < noteStems.length; i++) {
        const got = getEngine().getStemSamples([noteStems[i]], 0, song.duration);
        if (!got) continue;
        out[noteStems[i]] = await computeNoteMatrix(got.samples, got.sampleRate, (d) => setProgress((i + d) / noteStems.length));
        setMatrices({ ...out });
      }
    } catch (e) {
      console.error("[ChordRoll] compute failed:", e);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
    }
  };

  useEffect(() => {
    if (!open || !views.roll) return;
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
      const { matrices: m, ticked: on, stored: segs, transpose: tr } = live.current;
      const now = getEngine().getCurrentTime();
      const t0 = now - WINDOW_S / 2;
      const rows = SHOWN_HIGH - SHOWN_LOW + 1;
      const rowH = H / rows;
      const rollW = W - KEYS_W;
      const xOf = (t: number) => KEYS_W + ((t - t0) / WINDOW_S) * rollW;
      const yOf = (midi: number) => H - (midi - SHOWN_LOW + 1) * rowH;

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "#0f0f1e";
      ctx.fillRect(0, 0, W, H);
      for (let midi = SHOWN_LOW; midi <= SHOWN_HIGH; midi++) {
        const pc = midi % 12;
        ctx.fillStyle = BLACK.has(pc) ? "rgba(255,255,255,0.025)" : "rgba(255,255,255,0.055)";
        ctx.fillRect(KEYS_W, yOf(midi), rollW, rowH - 0.5);
      }

      const guideSegs = segs.map((s) => shiftSegment(s, tr)).filter((s) => s.end > t0 && s.start < t0 + WINDOW_S);
      for (const seg of guideSegs) {
        const x0 = Math.max(KEYS_W, xOf(seg.start));
        const x1 = Math.min(W, xOf(seg.end));
        ctx.fillStyle = "rgba(217,119,6,0.07)";
        ctx.fillRect(x0, 0, x1 - x0, H);
        const pcs = new Set(chordMidis(seg.chord, seg.bass, 0).map((n) => ((n % 12) + 12) % 12));
        ctx.fillStyle = "rgba(245,158,11,0.35)";
        for (let midi = SHOWN_LOW; midi <= SHOWN_HIGH; midi++) {
          if (pcs.has(midi % 12)) ctx.fillRect(x0, yOf(midi) + rowH / 2 - 0.5, x1 - x0, 1);
        }
      }

      ctx.globalCompositeOperation = "lighter";
      const f0 = Math.max(0, Math.floor(t0 / 0.125));
      const f1 = Math.ceil((t0 + WINDOW_S) / 0.125);
      const cellW = (0.125 / WINDOW_S) * rollW + 0.6;
      for (const [stem, matrix] of Object.entries(m)) {
        if (!on[stem]) continue;
        const color = STEM_COLORS[stem] ?? STEM_COLORS.other;
        for (let f = f0; f <= f1 && f < matrix.frames; f++) {
          const x = xOf(f * 0.125);
          for (let midi = Math.max(SHOWN_LOW, MIDI_LOW); midi <= Math.min(SHOWN_HIGH, MIDI_HIGH); midi++) {
            const v = noteStrength(matrix, f, midi);
            if (v < 25) continue;
            ctx.fillStyle = rgba(color, (v / 255) ** 1.6 * 0.95);
            ctx.fillRect(x, yOf(midi), cellW, rowH - 0.5);
          }
        }
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      for (const seg of guideSegs) {
        const x0 = Math.max(KEYS_W + 2, xOf(seg.start) + 3);
        ctx.fillStyle = "#f5e6c8";
        ctx.fillText(formatChordName(seg.chord, seg.bass), x0, 3);
        ctx.fillStyle = "rgba(245,158,11,0.5)";
        ctx.fillRect(xOf(seg.start), 0, 1, H);
      }

      ctx.fillStyle = "#14142a";
      ctx.fillRect(0, 0, KEYS_W, H);
      const frame = Math.floor(now / 0.125);
      for (let midi = SHOWN_LOW; midi <= SHOWN_HIGH; midi++) {
        const pc = midi % 12;
        let lit = 0;
        for (const [stem, matrix] of Object.entries(m)) if (on[stem]) lit = Math.max(lit, noteStrength(matrix, frame, midi));
        ctx.fillStyle = lit > LIT ? "#f59e0b" : BLACK.has(pc) ? "#1d1d38" : "#2a2a4a";
        ctx.fillRect(0, yOf(midi), BLACK.has(pc) ? KEYS_W * 0.6 : KEYS_W - 1, rowH - 0.5);
        if (pc === 0) {
          ctx.fillStyle = lit > LIT ? "#1a1a2e" : "#a0a0b0";
          ctx.fillText(`C${Math.floor(midi / 12) - 1}`, 2, yOf(midi) + rowH / 2 - 5);
        }
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(xOf(now), 0, 1.5, H);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [open, views.roll]);

  if (!song.hasChords) return null;
  const here = centerIndex >= 0 ? segments[centerIndex] : null;
  const candidate = tried && tried.index === centerIndex ? tried.chord : here?.chord ?? "C:maj";
  const computed = Object.keys(matrices).length > 0;
  void NOTE_NAMES;

  return (
    <section className="chord-roll">
      <header className="chord-roll__head">
        <button type="button" onClick={() => setOpen((v) => !v)}>{open ? "▾" : "▸"} Chord roll</button>
        {open && (
          <span className="chord-roll__views" role="group" aria-label="Views">
            <label><input type="checkbox" checked={views.roll} onChange={() => toggleView("roll")} /> Notes</label>
            <label><input type="checkbox" checked={views.spectrum} onChange={() => toggleView("spectrum")} /> Spectrum</label>
          </span>
        )}
        {open && views.roll && !computed && progress === null && <button type="button" onClick={compute}>Analyse notes</button>}
        {progress !== null && <span className="chord-roll__progress">{Math.round(progress * 100)}%</span>}
        {open && views.roll && noteStems.map((s) => (
          <label key={s} className="chord-roll__stem" style={{ borderColor: STEM_COLORS[s] }}>
            <input type="checkbox" checked={!!ticked[s]} onChange={() => setTicked({ ...ticked, [s]: !ticked[s] })} />
            {s}
          </label>
        ))}
        {error && <span className="chord-roll__error">{error}</span>}
      </header>
      {open && (
        <div className="chord-roll__body">
          {views.roll && <canvas ref={canvas} className="chord-roll__canvas" />}
          {views.spectrum && here && (
            <div className="chord-roll__spectrum">
              <ChordSpectrumPanel
                source={spectrumSource}
                start={here.start}
                end={here.end}
                currentTime={currentTime}
                chord={here.chord}
                bass={here.bass ?? null}
                candidate={candidate}
                onCandidate={(chord) => setTried({ index: centerIndex, chord })}
                soundingOffset={capo}
                tuningCents={tuningCents}
                busy={false}
                defaultLive
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
