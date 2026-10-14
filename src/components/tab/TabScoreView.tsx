import { useEffect, useMemo, useRef, useState } from "react";
import { usePlayerStore } from "../../stores/player";
import bravuraWoff2 from "@coderline/alphatab/font/Bravura.woff2?url";
import { loadAlphaTab, tabTracks, type TabTrackInfo } from "../../lib/tabScore";
import { barSpans, locate, timeAt } from "../../lib/tabSync";
import type { TabBar } from "../../lib/types";

interface TabScoreViewProps {
  bytes: Uint8Array;
  bars: readonly TabBar[];
  duration: number;
  /** Track index to show; the view reports the tracks it found through `onTracks`. */
  track: number | null;
  /** Play order of the bar the user picked to correct, if any. */
  selectedOrder: number | null;
  onTracks: (tracks: TabTrackInfo[]) => void;
  onSeek: (time: number) => void;
  onSelectBar: (order: number) => void;
  onError: (message: string) => void;
}

interface Bounds { x: number; y: number; w: number; h: number }
interface BarsLookup { findMasterBarByIndex(index: number): { realBounds: Bounds } | null }
interface AlphaApi {
  boundsLookup?: BarsLookup | null;
  destroy(): void;
}

/** Margin kept between the cursor and the left edge of the view while it scrolls, as a share of the view. */
const FOLLOW_SHARE = 0.3;

/**
 * The tab drawn by alphaTab with a cursor of our own: alphaTab's player is off,
 * so the position comes from the stored bar lines and the app's playback clock.
 */
export default function TabScoreView({
  bytes, bars, duration, track, selectedOrder, onTracks, onSeek, onSelectBar, onError,
}: TabScoreViewProps) {
  // Read here, not in the panel, so only the cursor re-renders at the clock's rate.
  const currentTime = usePlayerStore((s) => s.currentTime);
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<(AlphaApi & { renderTracks(t: unknown[]): void; score?: { tracks: unknown[] } }) | null>(null);
  const [ready, setReady] = useState(0);
  const [scoreVersion, setScoreVersion] = useState(0);
  const spans = useMemo(() => barSpans(bars, duration), [bars, duration]);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const positionRef = useRef(currentTime);
  positionRef.current = currentTime;
  const callbacks = useRef({ onTracks, onSeek, onSelectBar, onError });
  callbacks.current = { onTracks, onSeek, onSelectBar, onError };
  const [cursor, setCursor] = useState<Bounds | null>(null);
  const [selected, setSelected] = useState<Bounds | null>(null);

  useEffect(() => {
    let disposed = false;
    let api: AlphaApi | null = null;
    const host = hostRef.current;
    if (!host) return;

    (async () => {
      const at = await loadAlphaTab();
      if (disposed) return;
      const settings = new at.Settings();
      settings.core.useWorkers = false;
      settings.core.smuflFontSources = new Map([[at.FontFileFormat.Woff2, bravuraWoff2]]);
      settings.player.playerMode = at.PlayerMode.Disabled;
      settings.display.layoutMode = at.LayoutMode.Horizontal;
      settings.display.scale = 0.9;
      const instance = new at.AlphaTabApi(host, settings);
      api = instance as unknown as AlphaApi;
      apiRef.current = instance as unknown as typeof apiRef.current;

      instance.scoreLoaded.on((score) => {
        callbacks.current.onTracks(tabTracks(score));
        setScoreVersion((n) => n + 1);
      });
      instance.error.on((e) => callbacks.current.onError(e instanceof Error ? e.message : String(e)));
      instance.postRenderFinished.on(() => setReady((n) => n + 1));
      instance.beatMouseDown.on((beat) => {
        const bar = beat.voice.bar.masterBar;
        const current = locate(positionRef.current, spansRef.current);
        const occurrence = current && current.index === bar.index ? current.occurrence : 0;
        const length = bar.calculateDuration();
        const time = timeAt(bar.index, occurrence, length > 0 ? beat.playbackStart / length : 0, spansRef.current);
        if (time === null) return;
        const picked = locate(time, spansRef.current);
        if (picked) callbacks.current.onSelectBar(picked.order);
        callbacks.current.onSeek(time);
      });
      instance.load(bytes);
    })().catch((e: unknown) => {
      console.error("[TabScoreView] could not start alphaTab:", e);
      callbacks.current.onError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      apiRef.current = null;
      if (api) api.destroy();
    };
  }, [bytes]);

  useEffect(() => {
    const api = apiRef.current;
    const tracks = api?.score?.tracks;
    if (!api || !tracks || track === null || !tracks[track]) return;
    api.renderTracks([tracks[track]]);
  }, [track, scoreVersion]);

  useEffect(() => {
    const lookup = apiRef.current?.boundsLookup;
    if (!lookup) {
      setCursor(null);
      return;
    }
    const at = locate(currentTime, spans);
    const bounds = at ? lookup.findMasterBarByIndex(at.index)?.realBounds : null;
    if (!at || !bounds) {
      setCursor(null);
      return;
    }
    const x = bounds.x + bounds.w * at.fraction;
    setCursor({ x, y: bounds.y, w: 0, h: bounds.h });
    const view = scrollRef.current;
    if (view && (x < view.scrollLeft || x > view.scrollLeft + view.clientWidth * 0.9)) {
      view.scrollLeft = Math.max(0, x - view.clientWidth * FOLLOW_SHARE);
    }
  }, [currentTime, spans, ready]);

  useEffect(() => {
    const lookup = apiRef.current?.boundsLookup;
    const span = selectedOrder === null ? null : spans[selectedOrder];
    const bounds = span && lookup ? lookup.findMasterBarByIndex(span.index)?.realBounds : null;
    setSelected(bounds ?? null);
  }, [selectedOrder, spans, ready]);

  return (
    <div className="tab-score" ref={scrollRef}>
      <div className="tab-score__host" ref={hostRef} />
      {selected && (
        <div
          className="tab-score__selected"
          style={{ left: selected.x, top: selected.y, width: selected.w, height: selected.h }}
        />
      )}
      {cursor && <div className="tab-score__cursor" style={{ left: cursor.x, top: cursor.y, height: cursor.h }} />}
    </div>
  );
}
