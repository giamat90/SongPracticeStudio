import { useEffect, useMemo, useRef, useState } from "react";
import { isUnsure } from "../../lib/chords";
import { mapBlocks, mapTime } from "../../lib/chordMap";
import { formatChordName } from "../../lib/chordNames";
import type { ChordSegment } from "../../lib/types";

interface ChordRollMapProps {
  /** The chords with the names to show (as in the carousel), one per chord of the song. */
  chords: ReadonlyArray<{ segment: ChordSegment; chord: string; bass?: string | null }>;
  duration: number;
  currentTime: number;
  /** The chord picked on the roll, if any. */
  selected: number | null;
  onSeek: (time: number) => void;
}

/** A label fits in a chord's block when it has at least this much room. */
const MIN_LABEL_PX = 26;

/** The whole song's chords on one thin row, with the playhead on it: the overview the roll's ten seconds cannot give. */
export default function ChordRollMap({ chords, duration, currentTime, selected, onSeek }: ChordRollMapProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const measure = () => setSize({ w: Math.floor(el.clientWidth), h: Math.floor(el.clientHeight) });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, []);

  const blocks = useMemo(() => mapBlocks(chords.map((c) => c.segment), duration, size.w), [chords, duration, size.w]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || size.w <= 0 || size.h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.floor(size.w * dpr);
    el.height = Math.floor(size.h * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#12122a";
    ctx.fillRect(0, 0, size.w, size.h);
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const block of blocks) {
      const { segment, chord, bass } = chords[block.index];
      const active = currentTime >= segment.start && currentTime < segment.end;
      const w = block.x1 - block.x0 - 1;
      if (w < 1) continue;
      ctx.fillStyle = block.index === selected ? "rgba(245,158,11,0.75)" : active ? "rgba(245,158,11,0.5)" : "rgba(245,158,11,0.2)";
      ctx.fillRect(block.x0, 2, w, size.h - 4);
      if (block.index === selected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(block.x0 + 0.75, 2.75, w - 1.5, size.h - 5.5);
      }
      if (w >= MIN_LABEL_PX) {
        ctx.fillStyle = isUnsure(segment) ? "rgba(255,247,230,0.6)" : "#fff7e6";
        ctx.fillText(formatChordName(chord, bass), block.x0 + w / 2, size.h / 2 + 0.5);
      }
    }
    if (duration > 0) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(Math.min(size.w - 1.5, (currentTime / duration) * size.w), 0, 1.5, size.h);
    }
  }, [blocks, chords, currentTime, duration, selected, size]);

  return (
    <canvas
      ref={canvas}
      className="chord-roll__map"
      aria-label="The song's chords, whole song"
      title="The whole song: click to go there"
      onClick={(e) => onSeek(mapTime(e.clientX - e.currentTarget.getBoundingClientRect().left, duration, size.w))}
    />
  );
}
