import { MAX_CAPO_FRET, usePlayerStore } from "../../stores/player";
import type { Song } from "../../lib/types";

const FRETS = Array.from({ length: MAX_CAPO_FRET + 1 }, (_, i) => i);

interface CapoSelectProps {
  song: Song;
}

/** Where the capo is; the chord displays and the chord sheet show the shapes to play with it. */
export default function CapoSelect({ song }: CapoSelectProps) {
  const capo = usePlayerStore((s) => s.capo);
  const setCapo = usePlayerStore((s) => s.setCapo);
  if (!song.hasChords) return null;

  return (
    <select
      className="export-chart__capo"
      value={capo}
      onChange={(e) => setCapo(Number(e.target.value))}
      title="Capo: show the chords as the shapes to play with the capo on this fret"
      aria-label="Capo fret"
    >
      {FRETS.map((f) => (
        <option key={f} value={f}>{f === 0 ? "No capo" : `Capo ${f}`}</option>
      ))}
    </select>
  );
}
