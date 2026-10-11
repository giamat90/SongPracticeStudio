import { useEffect, useRef, useState } from "react";
import { usePlayerStore, getEngine } from "../../stores/player";
import { useAnalyzerPanels } from "../../stores/panels";
import TimeRuler from "./TimeRuler";
import ChordRow from "./ChordRow";
import StemTrack from "./StemTrack";
import TakeTrack from "./TakeTrack";
import type { Song, Take } from "../../lib/types";
import { computeZoomToCursor, computePan, wheelDeltaPixels, clamp } from "@giamat90/mps-core/zoomPan";

interface StemViewProps {
  song: Song;
}

function StemView({ song }: StemViewProps) {
  const loadSong      = usePlayerStore((s) => s.loadSong);
  const activeTakeId  = usePlayerStore((s) => s.activeTakeId);
  const shownTakeIds  = usePlayerStore((s) => s.shownTakeIds);
  const takes         = usePlayerStore((s) => s.takes);
  const showChords    = useAnalyzerPanels((s) => s.visible.chords);
  const setTakeVolume = usePlayerStore((s) => s.setTakeVolume);
  const timelineRef   = useRef<HTMLDivElement>(null);
  const stemRefs      = useRef<Record<string, HTMLDivElement | null>>({});
  const shownTakes = shownTakeIds
    .map((id) => takes.find((t) => t.id === id))
    .filter((t): t is Take => t !== undefined);
  // Lane containers by take id, and the takes currently loaded into the engine
  const takeRails     = useRef(new Map<string, HTMLDivElement>());
  const loadedTakes   = useRef(new Set<string>());
  const isLoading     = useRef(false);
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

  // Keep the engine's take tracks in step with the lanes on screen: load the
  // ones that appeared, drop the ones that were hidden or deleted.
  useEffect(() => {
    const eng = getEngine();
    const wanted = new Set(shownTakes.map((t) => t.id));
    for (const id of [...loadedTakes.current]) {
      if (wanted.has(id)) continue;
      eng.removeTakeTrack(id);
      loadedTakes.current.delete(id);
    }
    for (const take of shownTakes) {
      const rail = takeRails.current.get(take.id);
      if (loadedTakes.current.has(take.id) || !rail) continue;
      loadedTakes.current.add(take.id);
      eng.loadTakeTrack(take.id, take.filepath, rail, take.startPosition, take.audioOffset ?? 0, take.manualOffset ?? 0)
        .then(() => setTakeVolume(usePlayerStore.getState().takeVolume))
        .catch((e: unknown) => {
          loadedTakes.current.delete(take.id);
          console.error("[StemView] loadTakeTrack failed:", e);
        });
    }
  }, [shownTakeIds, takes]);

  // Ctrl+wheel zoom-to-cursor / shift+wheel pan. Attached as a native,
  // non-passive listener — React's onWheel prop is passive since React 17,
  // so preventDefault() there would not stop native ctrl+wheel page-zoom.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.shiftKey) return;
      e.preventDefault();
      e.stopPropagation();
      const { minPxPerSec, scrollTime, duration } = usePlayerStore.getState();
      if (duration <= 0) return;
      const eng = getEngine();
      eng.noteManualScrollInteraction();
      const rect = el.getBoundingClientRect();
      const cursorOffsetPx = e.clientX - rect.left;
      if (e.ctrlKey) {
        const { minPxPerSec: newPx, scrollTime: newScroll } = computeZoomToCursor({
          minPxPerSec, scrollTime, cursorOffsetPx, viewportWidthPx: rect.width, duration,
          deltaY: wheelDeltaPixels(e), minBound: eng.getMinPxPerSec(),
        });
        eng.zoomAll(newPx, newScroll);
        usePlayerStore.getState().setZoom(newPx, newScroll);
      } else {
        const newScroll = computePan({
          minPxPerSec, scrollTime, viewportWidthPx: rect.width, duration,
          deltaPx: wheelDeltaPixels(e, "x-or-y") * 1,
        });
        eng.setScrollAll(newScroll);
        usePlayerStore.getState().setScrollTime(newScroll);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Reclamp zoom/scroll on resize — zoom level persists, but the visible
  // window's bounds and the dynamic "whole song fits" lower bound both
  // depend on live container width.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const { minPxPerSec, scrollTime, duration } = usePlayerStore.getState();
      if (duration <= 0) return;
      const eng = getEngine();
      const minBound = eng.getMinPxPerSec();
      const newPx = Math.max(minPxPerSec, minBound);
      const viewportWidthPx = el.getBoundingClientRect().width;
      const maxScroll = Math.max(0, duration - viewportWidthPx / newPx);
      const newScroll = clamp(scrollTime, 0, maxScroll);
      eng.zoomAll(newPx, newScroll);
      usePlayerStore.getState().setZoom(newPx, newScroll);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div className="stem-view">
      {loadError && <div className="stem-view__error">{loadError}</div>}
      <div className="stem-view__timeline" ref={timelineRef}>
        {showChords && <ChordRow song={song} />}
        <TimeRuler />
        {song.stems.map((name) => (
          <StemTrack
            key={name}
            name={name}
            song={song}
            containerRef={(el) => { stemRefs.current[name] = el; }}
          />
        ))}
        {shownTakes.map((take) => (
          <TakeTrack
            key={take.id}
            take={take}
            label={take.name || `Take ${takes.indexOf(take) + 1}`}
            isActive={take.id === activeTakeId}
            song={song}
            containerRef={(el) => {
              if (el) takeRails.current.set(take.id, el);
              else takeRails.current.delete(take.id);
            }}
          />
        ))}
      </div>
    </div>
  );
}

export default StemView;
