import { toggleTake } from "@giamat90/mps-core/takes";
import { createDetachedBridge } from "@giamat90/mps-core/windows";
import type { Take } from "../lib/types";
import { isSharedState, type Command, type DetachablePanel, type SharedState } from "./protocol";

interface MutableStore<T> {
  getState(): T;
  setState(partial: Partial<T>): void;
}

/** What a panel in the detached window reads from the player store. */
export interface DetachedPlayer {
  song: SharedState["song"];
  duration: number;
  transpose: number;
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
  seek: (time: number) => void;
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
    writeTime: (time) => player.setState({ currentTime: time }),
    applyShared(shared, transport, currentTime) {
      player.setState({
        song: shared.song,
        duration: shared.duration,
        transpose: shared.transpose,
        takes: shared.takes,
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
  });

  await bridge.start();
  return { dispose: bridge.dispose };
}
