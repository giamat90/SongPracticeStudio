import { usePlayerStore } from "../../stores/player";
import { useChordSegments, formatChordName } from "../../lib/chords";
import type { Song } from "../../lib/types";

interface ChordRowProps {
  song: Song;
}

// Below this width a label can't render without clipping into an
// unreadable smear against its neighbors, so narrow, non-active segments
// fall back to an unlabeled tick mark at their boundary.
const MIN_LABEL_PX = 28;

export default function ChordRow({ song }: ChordRowProps) {
  const minPxPerSec = usePlayerStore((s) => s.minPxPerSec);
  const scrollTime  = usePlayerStore((s) => s.scrollTime);
  const { segments, activeIndex } = useChordSegments(song);

  if (segments.length === 0 || minPxPerSec <= 0) return null;

  return (
    <div className="chord-row">
      {segments.map((seg, i) => {
        const isActive = i === activeIndex;
        const width = (seg.end - seg.start) * minPxPerSec;
        const showLabel = isActive || width >= MIN_LABEL_PX;
        return (
          <span
            key={`${seg.start}-${seg.chord}`}
            className={`chord-row__chip${isActive ? " chord-row__chip--active" : ""}`}
            style={{
              left: `${(seg.start - scrollTime) * minPxPerSec}px`,
              width: `${width}px`,
            }}
          >
            {showLabel ? formatChordName(seg.chord, seg.bass) : null}
          </span>
        );
      })}
    </div>
  );
}
