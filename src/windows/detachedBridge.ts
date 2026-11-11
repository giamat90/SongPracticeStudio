import { toggleTake } from "@giamat90/mps-core/takes";
import { createDetachedBridge } from "@giamat90/mps-core/windows";
import type { BarMap, ClickDensity } from "@giamat90/mps-core/meter";
import { ENVELOPE_FPS } from "../lib/meterView";
import type { Take } from "../lib/types";
import type { TapSession } from "../stores/player/types";
import { EVT_ENVELOPE, isSharedState, type Command, type DetachablePanel, type SharedState } from "./protocol";
import { receiveEnvelope } from "./remoteEnvelope";

interface MutableStore<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
}

/** What a panel in the detached window reads from the player store. */
export interface DetachedPlayer {
  song: SharedState["song"];
  duration: number;
  transpose: number;
  capo: number;
  chordDetail: SharedState["chordDetail"];
  chordsRevision: number;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
  activeTakeId: string | null;
  shownTakeIds: string[];
  takePlayback: "all" | "selected";
  mutedTakeIds: string[];
  soloedTakeId: string | null;
  muteTakesWhileRecording: boolean;
  /** Mirrors the main window's take mute; the stems are not shown here. */
  mutedStems: Record<string, boolean>;
  soloedStem: string | null;
  isRecording: boolean;
  takes: Take[];
  meterMap: BarMap | null;
  meterEdited: boolean;
  meterSelected: number | null;
  meterBusy: boolean;
  meterError: string | null;
  /** Only its length is read (Undo); the entries stay in the main window. */
  meterHistory: { map: BarMap | null; edited: boolean }[];
  clickDensity: ClickDensity;
  tapSession: TapSession | null;
  seek: (time: number) => void;
  applyMeter: (map: BarMap | null, select?: number | null) => Promise<void>;
  undoMeter: () => Promise<void>;
  resetMeter: () => Promise<void>;
  detectMeter: () => Promise<void>;
  startMeterFromGrid: () => Promise<void>;
  finishTapping: () => Promise<void>;
  cancelTapping: () => void;
  clearMeterError: () => void;
  selectBar: (index: number | null) => void;
  setClickDensity: (density: ClickDensity) => void;
  startTapping: (session: Omit<TapSession, "taps">) => void;
  tapNow: () => void;
  addTap: (time: number) => void;
  applyLoopRegion: (start: number, end: number) => void;
  toggleTake: (id: string) => void;
  deleteTake: (id: string) => Promise<void>;
  renameTake: (id: string, name: string) => Promise<void>;
  /** The takes list asks for the takes when it mounts; here they are mirrored instead. */
  fetchTakes: () => Promise<void>;
}

export interface DetachedBridgeDeps {
  panelId: DetachablePanel;
  player: MutableStore<DetachedPlayer>;
  emit: (event: string, payload: unknown) => void | Promise<void>;
  listen: (event: string, cb: (payload: unknown) => void) => Promise<() => void>;
  now: () => number;
  /** The key the player store uses for the take channel's mute / solo. */
  takeTrackKey: string;
  /** Makes the drawing code read the mirrored playhead instead of the (empty) audio engine; returns how to undo it. */
  installPlayhead: (source: () => number) => () => void;
  /** The playhead as the drawing code reads it, for a tap. */
  playhead: () => number;
}

/**
 * Runs in a detached analyzer panel: mirrors the shared state into this
 * window's player store, so the panels are the very same components as in the
 * main window, and replaces the actions that would touch the audio engine by
 * commands to the main window.
 */
export async function startDetachedBridge(deps: DetachedBridgeDeps): Promise<{ dispose(): void }> {
  const { player } = deps;

  const bridge = createDetachedBridge<DetachablePanel, SharedState, Command>({
    panelId: deps.panelId,
    isShared: isSharedState,
    emit: deps.emit,
    listen: deps.listen,
    now: deps.now,
    installTimeSource: deps.installPlayhead,
    listeners: { [EVT_ENVELOPE]: (payload) => receiveEnvelope(payload, ENVELOPE_FPS) },
    writeTime: (time) => player.setState({ currentTime: time }),
    applyShared(shared, transport, currentTime) {
      player.setState({
        song: shared.song,
        duration: shared.duration,
        transpose: shared.transpose,
        capo: shared.capo,
        chordDetail: shared.chordDetail,
        chordsRevision: shared.chordsRevision,
        takes: shared.takes,
        meterMap: shared.meterMap,
        meterEdited: shared.meterEdited,
        meterSelected: shared.meterSelected,
        meterBusy: shared.meterBusy,
        meterError: shared.meterError,
        meterHistory: Array.from({ length: shared.meterUndoDepth }, () => ({ map: null, edited: false })),
        clickDensity: shared.clickDensity,
        tapSession: shared.tapSession,
        activeTakeId: shared.activeTakeId,
        shownTakeIds: shared.shownTakeIds,
        takePlayback: shared.takePlayback,
        mutedTakeIds: shared.mutedTakeIds,
        soloedTakeId: shared.soloedTakeId,
        mutedStems: { [deps.takeTrackKey]: shared.takesSilenced },
        soloedStem: null,
        muteTakesWhileRecording: shared.muteTakesWhileRecording,
        isRecording: shared.isRecording,
        isPlaying: transport.playing,
        playbackRate: transport.rate,
        currentTime,
      });
    },
  });

  player.setState({
    seek: (time) => {
      bridge.seekLocal(time);
      bridge.command({ type: "seek", time });
    },
    toggleTake: (id) => {
      const { shownTakeIds, activeTakeId } = player.getState();
      const next = toggleTake({ shown: shownTakeIds, active: activeTakeId }, id);
      player.setState({ shownTakeIds: [...next.shown], activeTakeId: next.active });
      bridge.command({ type: "toggleTake", id });
    },
    deleteTake: async (id) => bridge.command({ type: "deleteTake", id }),
    renameTake: async (id, name) => bridge.command({ type: "renameTake", id, name }),
    fetchTakes: async () => {},
    applyMeter: async (map, select) => {
      if (map) bridge.command({ type: "applyMeter", map, select });
    },
    undoMeter: async () => bridge.command({ type: "undoMeter" }),
    resetMeter: async () => bridge.command({ type: "resetMeter" }),
    detectMeter: async () => bridge.command({ type: "detectMeter" }),
    startMeterFromGrid: async () => bridge.command({ type: "startMeterFromGrid" }),
    finishTapping: async () => bridge.command({ type: "finishTapping" }),
    cancelTapping: () => bridge.command({ type: "cancelTapping" }),
    clearMeterError: () => bridge.command({ type: "clearMeterError" }),
    selectBar: (index) => {
      player.setState({ meterSelected: index });
      bridge.command({ type: "selectBar", index });
    },
    setClickDensity: (density) => {
      player.setState({ clickDensity: density });
      bridge.command({ type: "setClickDensity", density });
    },
    startTapping: (session) => bridge.command({ type: "startTapping", session }),
    tapNow: () => bridge.command({ type: "addTap", time: deps.playhead() }),
    addTap: (time) => bridge.command({ type: "addTap", time }),
    applyLoopRegion: (start, end) => bridge.command({ type: "applyLoopRegion", start, end }),
  });

  await bridge.start();
  return { dispose: bridge.dispose };
}
