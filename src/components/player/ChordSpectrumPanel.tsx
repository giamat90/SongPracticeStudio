import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHORD_NOTES, CHORD_QUALITIES, formatChordName } from "../../lib/chordNames";
import { chordVoicing } from "../../lib/chordVoicing";
import {
  DB_RANGE, F_MAX, F_MIN, FFT_SIZE, PRESENT_DB, candidateSpectrumDb, columnCurve, meanSpectrumDb, noteName,
  readTones, strongestExtra, type Overtones,
} from "../../lib/chordSpectrum";

/** Where the measured samples come from: the song's stems, summed. */
export interface SpectrumSource {
  stems: readonly string[];
  samples: (names: readonly string[], start: number, end: number) => { sampleRate: number; samples: Float32Array } | null;
}

interface ChordSpectrumPanelProps {
  source: SpectrumSource;
  /** The stretch of the song being looked at. */
  start: number;
  end: number;
  /** The playhead, for the live view. */
  currentTime: number;
  /** The chord the detector (or the user) has for this stretch, and the candidate being tried, as shown. */
  chord: string;
  bass: string | null;
  candidate: string;
  onCandidate: (chord: string) => void;
  /** Makes the candidate the chord of the stretch; without it the panel only looks. */
  onUse?: (chord: string) => void;
  /** Start on the playhead view instead of the chord's stretch. */
  defaultLive?: boolean;
  /** The slash bass of the chord being looked at and how to change it; without `onBass` there is no bass choice. */
  bassNote?: string | null;
  onBass?: (note: string | null) => void;
  /** Editing controls for the chord being looked at, shown between the Try row and the plot. */
  editor?: ReactNode;
  soundingOffset: number;
  tuningCents: number;
  busy: boolean;
}

// What the chord detector reads: no drums, no voice. The panel starts there and lets the user add or remove.
const DEFAULT_OFF = new Set(["drums", "vocals"]);
const ONSET_SKIP = 0.12;
const MAX_STRETCH = 3;

const COLOURS = { candidate: "#38bdf8", detected: "rgba(255,255,255,0.4)" };

function drawCurve(ctx: CanvasRenderingContext2D, curve: Float32Array, w: number, h: number, colour: string, fill: string | null, dashed: boolean) {
  const y = (db: number) => h * (1 - Math.max(0, db + DB_RANGE) / DB_RANGE);
  ctx.beginPath();
  for (let x = 0; x < curve.length; x++) {
    const px = (x / (curve.length - 1)) * w;
    if (x === 0) ctx.moveTo(px, y(curve[x]));
    else ctx.lineTo(px, y(curve[x]));
  }
  if (fill) {
    ctx.save();
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    for (let x = 0; x < curve.length; x++) {
      const px = (x / (curve.length - 1)) * w;
      if (x === 0) ctx.moveTo(px, y(curve[x]));
      else ctx.lineTo(px, y(curve[x]));
    }
  }
  ctx.setLineDash(dashed ? [6, 4] : []);
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

const xOf = (freq: number, w: number) => ((Math.log(freq) - Math.log(F_MIN)) / (Math.log(F_MAX) - Math.log(F_MIN))) * w;

function drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  ctx.font = "11px sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.45)";
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (let db = 0; db >= -DB_RANGE; db -= 20) {
    const y = h * (1 - (db + DB_RANGE) / DB_RANGE);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.fillText(`${db} dB`, 4, Math.min(h - 3, y + 12));
  }
  for (const octave of [2, 3, 4, 5, 6]) {
    const f = 440 * 2 ** ((12 * (octave + 1) - 69) / 12);
    if (f < F_MIN || f > F_MAX) continue;
    const x = xOf(f, w);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillText(`C${octave}`, x + 3, h - 4);
  }
}

function drawMarkers(ctx: CanvasRenderingContext2D, freqs: number[], tuning: number, w: number, h: number, colour: string) {
  ctx.strokeStyle = colour;
  ctx.fillStyle = colour;
  ctx.lineWidth = 1;
  const named = new Set<string>();
  for (const f of freqs) {
    const x = xOf(f, w);
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(x, 14);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.setLineDash([]);
    const name = noteName(f, tuning);
    if (!named.has(name)) ctx.fillText(name, x + 2, 11);
    named.add(name);
  }
}

/**
 * The spectrum of the chosen stems over a chord's stretch, with the spectrum of a synthetic candidate chord drawn
 * over it, to judge by eye whether the song has the notes of that chord (C minor or C minor 7, sus2 or minor).
 */
export default function ChordSpectrumPanel({
  source, start, end, currentTime, chord, bass, candidate, onCandidate, onUse, defaultLive = false, bassNote = null, onBass, editor, soundingOffset, tuningCents, busy,
}: ChordSpectrumPanelProps) {
  const [stems, setStems] = useState<string[]>(() => source.stems.filter((s) => !DEFAULT_OFF.has(s)));
  const [live, setLive] = useState(defaultLive);
  const [overtones, setOvertones] = useState<Overtones>("rich");
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth));
    return () => observer.disconnect();
  }, []);

  // The measured spectrum: the whole stretch averaged, or the window around the playhead.
  // The live view follows the playhead tenth by tenth, not frame by frame.
  const liveTenth = live ? Math.round(currentTime * 10) : 0;
  const measured = useMemo(() => {
    const probe = source.samples(stems, 0, 0.01);
    const sr = probe?.sampleRate ?? 44100;
    const [from, to] = live
      ? [liveTenth / 10 - FFT_SIZE / 2 / sr, liveTenth / 10 + FFT_SIZE / 2 / sr]
      : [start + ONSET_SKIP, Math.min(end, start + ONSET_SKIP + MAX_STRETCH)];
    const got = source.samples(stems, Math.max(0, from), to);
    return got ? { sampleRate: got.sampleRate, db: meanSpectrumDb(got.samples) } : null;
  }, [source, stems, live, start, end, liveTenth]);

  const sampleRate = measured?.sampleRate ?? 44100;
  const candidateDb = useMemo(
    () => candidateSpectrumDb(candidate, null, soundingOffset, tuningCents, sampleRate, overtones),
    [candidate, soundingOffset, tuningCents, sampleRate, overtones],
  );
  const detectedDb = useMemo(
    () => (candidate === chord ? null : candidateSpectrumDb(chord, bass, soundingOffset, tuningCents, sampleRate, overtones)),
    [candidate, chord, bass, soundingOffset, tuningCents, sampleRate, overtones],
  );
  const voicing = useMemo(() => chordVoicing(candidate, null, soundingOffset, tuningCents), [candidate, soundingOffset, tuningCents]);

  const readings = useMemo(() => {
    if (!measured || !voicing) return null;
    const tones = readTones(measured.db, measured.sampleRate, voicing, tuningCents);
    return { tones, extra: strongestExtra(measured.db, measured.sampleRate, tuningCents, tones) };
  }, [measured, voicing, tuningCents]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const h = Math.floor(el.clientHeight);
    el.width = Math.floor(width * dpr);
    el.height = Math.floor(h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, h);
    drawGrid(ctx, width, h);
    if (measured) drawCurve(ctx, columnCurve(measured.db, measured.sampleRate, width), width, h, "#f59e0b", "rgba(245, 158, 11, 0.22)", false);
    if (detectedDb) drawCurve(ctx, columnCurve(detectedDb, sampleRate, width), width, h, COLOURS.detected, null, true);
    if (candidateDb) drawCurve(ctx, columnCurve(candidateDb, sampleRate, width), width, h, COLOURS.candidate, null, false);
    if (voicing) drawMarkers(ctx, [voicing.bass, ...voicing.upper], tuningCents, width, h, COLOURS.candidate);
  }, [width, measured, candidateDb, detectedDb, voicing, sampleRate, tuningCents]);

  const [candRoot, candQuality] = candidate.split(":");
  const toggleStem = (name: string) => setStems((cur) => (cur.includes(name) ? cur.filter((s) => s !== name) : [...cur, name]));

  return (
    <div className="chord-spectrum" role="group" aria-label="Chord spectrum">
      <div className="chord-spectrum__row">
        <span className="chord-spectrum__label">Stems</span>
        {source.stems.map((name) => (
          <label key={name} className="chord-spectrum__check">
            <input type="checkbox" checked={stems.includes(name)} onChange={() => toggleStem(name)} />
            {name}
          </label>
        ))}
        <select className="chord-editor__select" value={live ? "live" : "stretch"} onChange={(e) => setLive(e.target.value === "live")} aria-label="What to measure">
          <option value="stretch">This chord's stretch</option>
          <option value="live">Playhead</option>
        </select>
      </div>

      <div className="chord-spectrum__row">
        <span className="chord-spectrum__label">Chord</span>
        <select className="chord-editor__select" value={candRoot} disabled={busy} onChange={(e) => onCandidate(`${e.target.value}:${candQuality}`)} aria-label="Candidate root">
          {CHORD_NOTES.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {CHORD_QUALITIES.map((q) => (
          <button
            key={q.value}
            type="button"
            className={`chord-editor__chip${candQuality === q.value ? " chord-editor__chip--previewed" : ""}`}
            onClick={() => onCandidate(`${candRoot}:${q.value}`)}
            aria-pressed={candQuality === q.value}
            title={q.label}
          >
            {formatChordName(`${candRoot}:${q.value}`)}
          </button>
        ))}
        {onBass && (
          <select
            className="chord-editor__select"
            value={bassNote ?? ""}
            disabled={busy}
            onChange={(e) => onBass(e.target.value || null)}
            aria-label="Bass note"
            title="The bass note, when it is not the root (a slash chord)"
          >
            <option value="">no slash bass</option>
            {CHORD_NOTES.map((n) => <option key={n} value={n}>/{n}</option>)}
          </select>
        )}
        {onUse && (
          <button
            type="button"
            className="chord-editor__button chord-editor__button--primary"
            disabled={busy || candidate === chord}
            onClick={() => onUse(candidate)}
            title="Make this the chord of the stretch"
          >
            Use {formatChordName(candidate)}
          </button>
        )}
        <select
          className="chord-editor__select"
          value={overtones}
          onChange={(e) => setOvertones(e.target.value === "pure" ? "pure" : "rich")}
          aria-label="Candidate overtones"
          title="How the synthetic chord is built: like a guitar (eight overtones) or like the Hear button (two)"
        >
          <option value="rich">Candidate like an instrument</option>
          <option value="pure">Candidate like the Hear button</option>
        </select>
      </div>

      {editor}

      <canvas ref={canvas} className="chord-spectrum__canvas" aria-label="Spectrum of the song and of the candidate chord" />

      <div className="chord-spectrum__legend">
        <span style={{ color: "#f59e0b" }}>■ the song ({stems.join(" + ") || "no stems"})</span>
        <span style={{ color: COLOURS.candidate }}>— {formatChordName(candidate)} (candidate)</span>
        {detectedDb && <span style={{ color: COLOURS.detected }}>- - {formatChordName(chord, bass)} (now)</span>}
      </div>

      {!measured && <div className="chord-spectrum__note">No audio for the chosen stems here yet.</div>}
      {readings && (
        <div className="chord-spectrum__readings">
          <span className="chord-spectrum__label">Notes of {formatChordName(candidate)} in the song</span>
          {readings.tones.map((t) => (
            <span key={t.note} className={`chord-spectrum__tone${t.db !== null && t.db >= PRESENT_DB && !t.overtoneOf ? " chord-spectrum__tone--present" : ""}`}>
              {t.note} {t.db === null ? "absent" : `${Math.round(t.db)} dB`}{t.overtoneOf ? ` (overtone of ${t.overtoneOf}?)` : ""}
            </span>
          ))}
          <span className="chord-spectrum__extra">
            {readings.extra ? `Strongest note it does not have: ${readings.extra.note} (${Math.round(readings.extra.db)} dB)` : "Nothing strong is left over"}
          </span>
        </div>
      )}
    </div>
  );
}
