import { usePlayerStore } from "../../stores/player";
import { CHORD_DETAILS, isChordDetail } from "../../lib/chordNames";
import type { Song } from "../../lib/types";

interface ChordDetailSelectProps {
  song: Song;
}

/** How much of each chord to show: triads only, with sevenths, or everything detected. */
export default function ChordDetailSelect({ song }: ChordDetailSelectProps) {
  const detail = usePlayerStore((s) => s.chordDetail);
  const setDetail = usePlayerStore((s) => s.setChordDetail);
  if (!song.hasChords) return null;

  return (
    <select
      className="export-chart__capo"
      value={detail}
      onChange={(e) => { if (isChordDetail(e.target.value)) setDetail(e.target.value); }}
      title={CHORD_DETAILS.find((d) => d.value === detail)?.hint}
      aria-label="Chord detail"
    >
      {CHORD_DETAILS.map((d) => (
        <option key={d.value} value={d.value} title={d.hint}>{d.label}</option>
      ))}
    </select>
  );
}
