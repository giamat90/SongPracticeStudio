import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import { readBassTab } from "../../lib/tauri";
import { exportBassMidi } from "../../lib/exports";
import {
  BASS_STRING_NAMES, TAB_WINDOW_SECONDS, tabTimeToX, tabWindowStart, tabXToTime, visibleNotes,
  type BassTabData,
} from "../../lib/bassTab";
import type { Song } from "../../lib/types";
import PanelTitle from "../panels/PanelTitle";
import { usePanelCollapse } from "../../stores/collapsed";

const STRING_ROWS = BASS_STRING_NAMES.length;

interface BassTabPanelProps {
  song: Song;
}

/** The bass stem's transcription as a four-string tab that scrolls with the playhead; click to seek. */
export default function BassTabPanel({ song }: BassTabPanelProps) {
  const [tab, setTab] = useState<BassTabData | null>(null);
  const [exporting, setExporting] = useState(false);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const seek = usePlayerStore((s) => s.seek);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasBass = song.stems.includes("bass");
  const collapse = usePanelCollapse("bassTab");
  const { open } = collapse;

  useEffect(() => {
    setTab(null);
    if (!hasBass) return;
    let cancelled = false;
    readBassTab(song.id)
      .then((data) => { if (!cancelled) setTab(data); })
      .catch((e: unknown) => console.error("[BassTabPanel] readBassTab failed:", e));
    return () => { cancelled = true; };
  }, [song.id, hasBass]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !tab) return;
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const styles = getComputedStyle(canvas);
    const accent = styles.getPropertyValue("--accent").trim() || "#4a9eff";
    const dim = styles.getPropertyValue("--text-secondary").trim() || "#999";
    const strong = styles.getPropertyValue("--text-primary").trim() || "#fff";
    const surface = styles.getPropertyValue("--bg-surface").trim() || "#333";

    const start = tabWindowStart(currentTime);
    const rowHeight = height / (STRING_ROWS + 1);
    const rowY = (stringIndex: number) => rowHeight * (STRING_ROWS - stringIndex);

    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = surface;
    ctx.lineWidth = Math.max(1, ratio);
    for (let s = 0; s < STRING_ROWS; s++) {
      ctx.beginPath();
      ctx.moveTo(0, rowY(s));
      ctx.lineTo(width, rowY(s));
      ctx.stroke();
    }

    ctx.font = `${Math.round(rowHeight * 0.8)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const note of visibleNotes(tab.notes, start, start + TAB_WINDOW_SECONDS)) {
      const x0 = tabTimeToX(note.time, start, width);
      const x1 = tabTimeToX(note.time + note.duration, start, width);
      const w = Math.max(2, x1 - x0);
      const y = rowY(Math.max(0, Math.min(STRING_ROWS - 1, note.string)));
      const sounding = currentTime >= note.time && currentTime < note.time + note.duration;
      ctx.fillStyle = sounding ? accent : surface;
      ctx.fillRect(x0, y - rowHeight * 0.4, w, rowHeight * 0.8);
      ctx.fillStyle = sounding ? strong : dim;
      ctx.fillText(String(note.fret), x0 + w / 2, y);
    }

    const playheadX = tabTimeToX(currentTime, start, width);
    ctx.strokeStyle = accent;
    ctx.beginPath();
    ctx.moveTo(playheadX, 0);
    ctx.lineTo(playheadX, height);
    ctx.stroke();
  }, [open, tab, currentTime]);

  if (!hasBass || !tab || tab.notes.length === 0) return null;

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const start = tabWindowStart(usePlayerStore.getState().currentTime);
    const t = tabXToTime(e.clientX - rect.left, start, rect.width);
    seek(Math.max(0, Math.min(song.duration, t)));
  };

  const handleExport = async () => {
    setExporting(true);
    try {
      await exportBassMidi(song.title, tab.notes, song.detectedBpm ?? 0);
    } catch (e) {
      console.error("[BassTabPanel] MIDI export failed:", e);
    } finally {
      setExporting(false);
    }
  };

  return (
    <section className="bass-tab" aria-label="Bass tab">
      <div className="panel-bar">
        <PanelTitle collapse={collapse}>🎸 Bass tab</PanelTitle>
      </div>
      {open && (
        <div className="bass-tab__body">
          <header className="bass-tab__header">
            <span className="bass-tab__strings" aria-hidden="true">{[...BASS_STRING_NAMES].reverse().join(" ")}</span>
            <button
              className="bass-tab__export"
              onClick={() => void handleExport()}
              disabled={exporting}
              title="Save the bass line as a MIDI file"
              aria-label="Export the bass tab as a MIDI file"
            >
              {exporting ? "Exporting…" : "Export MIDI"}
            </button>
          </header>
          <canvas ref={canvasRef} className="bass-tab__canvas" onClick={handleClick} />
        </div>
      )}
    </section>
  );
}
