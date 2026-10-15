import type { CSSProperties } from "react";
import { useChordSegments, formatChordName } from "../../lib/chords";
import type { Song } from "../../lib/types";

interface ChordCarouselProps {
  song: Song;
}

interface SlotStyle extends CSSProperties {
  "--dist": number;
  "--dist-abs": number;
}

// Chords shown on each side of the current one, like the past/future ticks
// on a gauge dial centered on "now".
const RADIUS = 2;

export default function ChordCarousel({ song }: ChordCarouselProps) {
  const { segments, display, activeIndex, centerIndex } = useChordSegments(song);
  if (!song.hasChords || segments.length === 0) return null;

  const slots = Array.from({ length: RADIUS * 2 + 1 }, (_, i) => {
    const offset = i - RADIUS;
    const segIndex = centerIndex + offset;
    return { offset, segment: segIndex >= 0 && segIndex < segments.length ? segments[segIndex] : null, shown: segIndex >= 0 && segIndex < segments.length ? display[segIndex] : null };
  });

  const activeChord = activeIndex >= 0 ? display[activeIndex] : null;

  return (
    <div
      className="chord-carousel"
      role="img"
      aria-label={activeChord ? `Now playing chord ${formatChordName(activeChord.chord, activeChord.bass)}` : "Chords"}
    >
      {slots.map(({ offset, segment, shown }) => {
        const isCenter = offset === 0;
        const isActive = isCenter && activeIndex === centerIndex && activeIndex >= 0;
        const position = offset < 0 ? "past" : offset > 0 ? "next" : "now";
        return (
          <span
            key={segment ? `${segment.start}-${segment.chord}` : `empty-${offset}`}
            className={`chord-carousel__slot chord-carousel__slot--${position}${isActive ? " chord-carousel__slot--active" : ""}`}
            style={{ "--dist": offset, "--dist-abs": Math.abs(offset) } as SlotStyle}
          >
            {shown ? formatChordName(shown.chord, shown.bass) : ""}
          </span>
        );
      })}
    </div>
  );
}
