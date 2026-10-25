import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { usePlayerStore } from "../../stores/player";
import bravuraWoff2 from "@coderline/alphatab/font/Bravura.woff2?url";
import { loadAlphaTab, tabTracks, type TabTrackInfo } from "../../lib/tabScore";
import { firstNoteOfBar, neighbourNote, type TabNoteModel } from "../../lib/tabEdit";
import { applyTranspose, clearTranspose, type TransposeOptions, type TransposeResult } from "../../lib/tabTranspose";
import { barSpans, cursorX, locate, timeAt, type BeatStop } from "../../lib/tabSync";
import type { TabBar } from "../../lib/types";

interface TabScoreViewProps {
  bytes: Uint8Array;
  /** The view reads `bytes` again only when this changes; edits made in the view must not reload it. */
  source: number;
  bars: readonly TabBar[];
  duration: number;
  /** Track index to show; the view reports the tracks it found through `onTracks`. */
  track: number | null;
  /** Play order of the bar the user picked to correct, if any. */
  selectedOrder: number | null;
  /** While true a click on a note picks it for editing (a click always seeks). */
  editing: boolean;
  selectedNote: TabNoteModel | null;
  /** What the panel can ask of the view: draw the (edited) score again, hand over the live score. */
  handleRef: Ref<TabViewHandle>;
  onPickNote: (note: TabNoteModel) => void;
  /** What the song's transposition did to the notes, each time the score is drawn again for it. */
  onTransposed: (result: TransposeResult) => void;
  /** The string choices saved for the current transposition, read each time the tab is drawn transposed. */
  getTransposeOptions: () => TransposeOptions;
  /** Bumped when saved choices were loaded after the tab was drawn, so it is drawn again with them. */
  editsVersion: number;
  onTracks: (tracks: TabTrackInfo[]) => void;
  onSeek: (time: number) => void;
  onSelectBar: (order: number) => void;
  onError: (message: string) => void;
}

export interface TabViewHandle {
  /** Draw the score again after a note was changed in the model. */
  rerender(): void;
  /** The live score, the one the user is editing. */
  getScore(): AlphaScore | null;
  /**
   * Move the playhead to the start of the next or previous bar in play order (repeats count again) and select that
   * bar. Returns the bar's first note, or null at the ends of the tab and for a bar of rests.
   */
  stepBar(direction: "previous" | "next", near: TabNoteModel | null): TabNoteModel | null;
  /**
   * Put the playhead on the previous or next note after `from`, or after the note at the playhead when nothing is
   * picked, and select its bar. Returns that note, or null at the ends of the tab.
   */
  stepNote(direction: "previous" | "next", from: TabNoteModel | null): TabNoteModel | null;
}

type AlphaScore = import("@coderline/alphatab").model.Score;

interface Bounds { x: number; y: number; w: number; h: number }
interface BarsLookup {
  findMasterBarByIndex(index: number): { realBounds: Bounds } | null;
  findBeat(beat: unknown): { onNotesX: number; notes: { note: unknown; noteHeadBounds: Bounds }[] | null } | null;
}
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
  bytes, source, bars, duration, track, selectedOrder, editing, selectedNote, handleRef, onPickNote, onTransposed, getTransposeOptions, editsVersion, onTracks,
  onSeek, onSelectBar, onError,
}: TabScoreViewProps) {
  // Read here, not in the panel, so only the cursor re-renders at the clock's rate.
  const currentTime = usePlayerStore((s) => s.currentTime);
  const transpose = usePlayerStore((s) => s.transpose);
  const alphaTabRef = useRef<Awaited<ReturnType<typeof loadAlphaTab>> | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const bytesRef = useRef(bytes);
  bytesRef.current = bytes;
  const hostRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<(AlphaApi & { renderTracks(t: unknown[]): void; score?: AlphaScore }) | null>(null);
  const trackRef = useRef(track);
  trackRef.current = track;
  /** Scroll position to put back once a redraw of an edited score finishes. */
  const scrollBack = useRef<number | null>(null);
  const [ready, setReady] = useState(0);
  const [scoreVersion, setScoreVersion] = useState(0);
  const spans = useMemo(() => barSpans(bars, duration), [bars, duration]);
  const spansRef = useRef(spans);
  spansRef.current = spans;
  const positionRef = useRef(currentTime);
  positionRef.current = currentTime;
  const callbacks = useRef({ onTracks, onSeek, onSelectBar, onError, onPickNote, onTransposed, getTransposeOptions });
  callbacks.current = { onTracks, onSeek, onSelectBar, onError, onPickNote, onTransposed, getTransposeOptions };
  const [cursor, setCursor] = useState<Bounds | null>(null);
  const [selected, setSelected] = useState<Bounds | null>(null);
  const [noteBox, setNoteBox] = useState<Bounds | null>(null);

  useImperativeHandle(handleRef, () => ({
    rerender() {
      const api = apiRef.current;
      const tracks = api?.score?.tracks;
      const shown = trackRef.current;
      if (!api || !tracks || shown === null || !tracks[shown]) return;
      scrollBack.current = scrollRef.current?.scrollLeft ?? null;
      api.renderTracks([tracks[shown]]);
    },
    getScore: () => apiRef.current?.score ?? null,
    stepNote(direction, from) {
      const spans = spansRef.current;
      const current = locate(positionRef.current, spans);
      const shown = trackRef.current;
      const score = apiRef.current?.score;
      const bars = shown === null ? undefined : score?.tracks[shown]?.staves[0]?.bars;
      if (!bars || !score) return null;
      if (!current) {
        // Before the first bar line: "next" goes to the first note of the tab.
        const first = spans[0];
        const note = direction === "next" && first ? firstNoteOfBar(bars[first.index]) : null;
        if (note && first) {
          callbacks.current.onSelectBar(first.order);
          callbacks.current.onSeek(first.start);
        }
        return note;
      }

      let anchor = from;
      if (!anchor) {
        // The last note at or before the playhead in this bar.
        const tick = current.fraction * score.masterBars[current.index].calculateDuration();
        const beats = bars[current.index]?.voices[0]?.beats ?? [];
        const at = beats.filter((b) => b.notes.length > 0 && b.playbackStart <= tick + 1).pop();
        anchor = at ? at.notes[0] : null;
      }
      const target = anchor ? neighbourNote(anchor, direction) : direction === "next" ? firstNoteOfBar(bars[current.index]) : null;
      if (!target) return null;

      const bar = target.beat.voice.bar.masterBar;
      // The pass over a repeated bar the playhead is in, or the one it moves on to or back to.
      const near = [current.order, current.order + 1, current.order - 1].map((o) => spans[o]).find((s) => s?.index === bar.index);
      const length = bar.calculateDuration();
      const time = timeAt(bar.index, near?.occurrence ?? 0, length > 0 ? target.beat.playbackStart / length : 0, spans);
      if (time === null) return null;
      const reached = locate(time, spans);
      if (reached) callbacks.current.onSelectBar(reached.order);
      callbacks.current.onSeek(time);
      return target;
    },
    stepBar(direction, near) {
      const spans = spansRef.current;
      const current = locate(positionRef.current, spans);
      const from = current ? current.order : direction === "next" ? -1 : spans.length;
      const target = spans[from + (direction === "next" ? 1 : -1)];
      if (!target) return null;
      callbacks.current.onSeek(target.start);
      callbacks.current.onSelectBar(target.order);
      const shown = trackRef.current;
      const bar = shown === null ? undefined : apiRef.current?.score?.tracks[shown]?.staves[0]?.bars[target.index];
      return bar ? firstNoteOfBar(bar, near) : null;
    },
  }), []);

  useEffect(() => {
    let disposed = false;
    let api: AlphaApi | null = null;
    const host = hostRef.current;
    if (!host) return;

    (async () => {
      const at = await loadAlphaTab();
      if (disposed) return;
      alphaTabRef.current = at;
      const settings = new at.Settings();
      settings.core.useWorkers = false;
      settings.core.includeNoteBounds = true;
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
      instance.postRenderFinished.on(() => {
        if (scrollBack.current !== null && scrollRef.current) scrollRef.current.scrollLeft = scrollBack.current;
        scrollBack.current = null;
        setReady((n) => n + 1);
      });
      instance.noteMouseDown.on((note) => {
        if (editingRef.current) callbacks.current.onPickNote(note);
      });
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
      instance.load(bytesRef.current);
    })().catch((e: unknown) => {
      console.error("[TabScoreView] could not start alphaTab:", e);
      callbacks.current.onError(e instanceof Error ? e.message : String(e));
    });

    return () => {
      disposed = true;
      // The score outlives the view (a pending save exports it), so it must not keep a transposition.
      const score = apiRef.current?.score;
      if (score) clearTranspose(score);
      apiRef.current = null;
      if (api) api.destroy();
    };
  }, [source]);

  useEffect(() => {
    const api = apiRef.current;
    const tracks = api?.score?.tracks;
    if (!api || !tracks || track === null || !tracks[track]) return;
    const at = alphaTabRef.current;
    if (at && api.score) {
      callbacks.current.onTransposed(applyTranspose(at, api.score, transpose, callbacks.current.getTransposeOptions()));
      scrollBack.current = scrollRef.current?.scrollLeft ?? null;
    }
    api.renderTracks([tracks[track]]);
  }, [track, scoreVersion, transpose, editsVersion]);

  /** Where the notes of a bar are drawn, for the cursor to sit on them. */
  const beatStops = (index: number): BeatStop[] => {
    const api = apiRef.current;
    const lookup = api?.boundsLookup;
    const shown = trackRef.current;
    const beats = shown === null ? undefined : api?.score?.tracks[shown]?.staves[0]?.bars[index]?.voices[0]?.beats;
    if (!lookup || !beats) return [];
    const stops: BeatStop[] = [];
    for (const beat of beats) {
      const found = lookup.findBeat(beat);
      if (found) stops.push({ tick: beat.playbackStart, x: found.onNotesX });
    }
    return stops;
  };
  const barLength = (index: number) => apiRef.current?.score?.masterBars[index]?.calculateDuration() ?? 0;

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
    const x = cursorX(beatStops(at.index), { x: bounds.x, w: bounds.w, length: barLength(at.index) }, at.fraction);
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

  useEffect(() => {
    const lookup = apiRef.current?.boundsLookup;
    const box = selectedNote && lookup
      ? lookup.findBeat(selectedNote.beat)?.notes?.find((n) => n.note === selectedNote)?.noteHeadBounds
      : null;
    setNoteBox(box ?? null);
    const view = scrollRef.current;
    if (box && view && (box.x < view.scrollLeft || box.x + box.w > view.scrollLeft + view.clientWidth)) {
      view.scrollLeft = Math.max(0, box.x - view.clientWidth * FOLLOW_SHARE);
    }
  }, [selectedNote, ready]);

  return (
    <div className="tab-score" ref={scrollRef}>
      <div className="tab-score__host" ref={hostRef} />
      {selected && (
        <div
          className="tab-score__selected"
          style={{ left: selected.x, top: selected.y, width: selected.w, height: selected.h }}
        />
      )}
      {noteBox && (
        <div
          className="tab-score__note"
          style={{ left: noteBox.x, top: noteBox.y, width: noteBox.w, height: noteBox.h }}
        />
      )}
      {cursor && <div className="tab-score__cursor" style={{ left: cursor.x, top: cursor.y, height: cursor.h }} />}
    </div>
  );
}
