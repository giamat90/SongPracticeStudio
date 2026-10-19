import { useEffect, useMemo, useRef, useState } from "react";
import ChordSpectrumPanel from "./ChordSpectrumPanel";
import { readChordTuning } from "../../lib/tauri";
import { getEngine, usePlayerStore } from "../../stores/player";
import { STEM_COLORS } from "../../audio/engine";
import { formatChordName, shiftSegment, useChordSegments } from "../../lib/chords";
import { MIDI_HIGH, MIDI_LOW, chordPitchClasses, computeNoteMatrix, noteStrength, type NoteMatrix } from "../../lib/noteRoll";
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
/** Lowest and highest note the roll can be set to show: bass guitar's low E up to a guitar's top. */
const LOW_OPTIONS = [28, 36, 48];
const HIGH_OPTIONS = [60, 72, 84, 88];

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
  const [matrices, setMatrices] = useState<Record<string, NoteMatrix>>({});
  const [progress, setProgress] = useState<number | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [error, setError] = useState<string | null>(null);
  const transpose = usePlayerStore((s) => s.transpose);
  const capo = usePlayerStore((s) => s.capo);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const revision = usePlayerStore((s) => s.chordsRevision);
  const { stored, segments, centerIndex } = useChordSegments(song);
  const [tuningCents, setTuningCents] = useState(0);
  const [tried, setTried] = useState<{ index: number; chord: string } | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef({ matrices, ticked, stored, transpose, prefs });
  live.current = { matrices, ticked, stored, transpose, prefs };

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

  const noteStems = useMemo(() => song.stems.filter((s) => !NOT_NOTES.has(s)), [song.stems]);

  useEffect(() => {
    setMatrices({});
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
      const { matrices: m, ticked: on, stored: segs, transpose: tr, prefs: p } = live.current;
      const low = p.low;
      const high = p.high;
      const now = getEngine().getCurrentTime();
      const t0 = now - WINDOW_S / 2;
      const rows = high - low + 1;
      const rowH = H / rows;
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
        .map((s) => shiftSegment(s, tr))
        .filter((s) => s.end > t0 && s.start < t0 + WINDOW_S)
        .map((seg) => ({ seg, pcs: chordPitchClasses(seg.chord, seg.bass) }));
      for (const { seg, pcs } of chords) {
        const x0 = Math.max(KEYS_W, xOf(seg.start));
        const x1 = Math.min(W, xOf(seg.end));
        ctx.fillStyle = "rgba(217,119,6,0.07)";
        ctx.fillRect(x0, 0, x1 - x0, H);
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
            const v = noteStrength(matrix, f, midi);
            if (v < 25) continue;
            const fade = inChord && inChord.pcs.size > 0 && !inChord.pcs.has(midi % 12) ? OFF_CHORD_FADE : 1;
            ctx.fillStyle = rgba(color, (v / 255) ** 1.6 * 0.95 * fade);
            ctx.fillRect(x, yOf(midi), cellW, rowH - 0.5);
          }
        }
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.font = "11px sans-serif";
      ctx.textBaseline = "top";
      for (const { seg, pcs } of chords) {
        const startX = xOf(seg.start);
        ctx.fillStyle = "#f5e6c8";
        ctx.fillText(formatChordName(seg.chord, seg.bass), Math.max(KEYS_W + 2, startX + 3), 3);
        ctx.fillStyle = "rgba(245,158,11,0.5)";
        ctx.fillRect(startX, 0, 1, H);
        if (startX < KEYS_W) continue;
        ctx.fillStyle = "rgba(251,191,36,0.95)";
        for (let midi = low; midi <= high; midi++) {
          if (pcs.has(midi % 12)) ctx.fillRect(startX + 1, yOf(midi) + 1, 3, rowH - 2.5);
        }
      }

      ctx.fillStyle = "#14142a";
      ctx.fillRect(0, 0, KEYS_W, H);
      const frame = Math.floor(now / 0.125);
      for (let midi = low; midi <= high; midi++) {
        const pc = midi % 12;
        let lit = 0;
        for (const [stem, matrix] of Object.entries(m)) if (on[stem]) lit = Math.max(lit, noteStrength(matrix, frame, midi));
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
  const here = centerIndex >= 0 ? segments[centerIndex] : null;
  const candidate = tried && tried.index === centerIndex ? tried.chord : here?.chord ?? "C:maj";
  const computed = Object.keys(matrices).length > 0;

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
        {prefs.roll && !computed && progress === null && <button type="button" onClick={compute}>Analyse notes</button>}
        {progress !== null && <span className="chord-roll__progress">{Math.round(progress * 100)}%</span>}
        {prefs.roll && noteStems.map((s) => (
          <label key={s} className="chord-roll__stem" style={{ borderColor: STEM_COLORS[s] }}>
            <input type="checkbox" checked={!!ticked[s]} onChange={() => setTicked({ ...ticked, [s]: !ticked[s] })} />
            {s}
          </label>
        ))}
        {error && <span className="chord-roll__error">{error}</span>}
      </header>
      <div className="chord-roll__body">
        {prefs.roll && <canvas ref={canvas} className="chord-roll__canvas" />}
        {prefs.spectrum && here && (
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
    </section>
  );
}
