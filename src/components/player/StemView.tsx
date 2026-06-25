import { useEffect, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import TimeRuler from "./TimeRuler";
import StemTrack from "./StemTrack";
import type { Song } from "../../lib/types";

interface StemViewProps {
  song: Song;
}

function StemView({ song }: StemViewProps) {
  const loadSong    = usePlayerStore((s) => s.loadSong);
  const stemRefs    = useRef<Record<string, HTMLDivElement | null>>({});
  const isLoading   = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading.current) return;
    isLoading.current = true;
    setLoadError(null);

    const containers: Record<string, HTMLElement> = {};
    for (const name of song.stems) {
      const el = stemRefs.current[name];
      if (el) containers[name] = el;
    }

    loadSong(song, containers)
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[StemView] loadSong failed:", msg);
        setLoadError(msg);
      })
      .finally(() => { isLoading.current = false; });

    return () => { isLoading.current = false; };
  }, [song.id]);

  return (
    <div className="stem-view">
      {loadError && <div className="stem-view__error">{loadError}</div>}
      <TimeRuler />
      {song.stems.map((name) => (
        <StemTrack
          key={name}
          name={name}
          song={song}
          containerRef={(el) => { stemRefs.current[name] = el; }}
        />
      ))}
    </div>
  );
}

export default StemView;
