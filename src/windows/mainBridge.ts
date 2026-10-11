import { startMainBridge as startCoreBridge } from "@giamat90/mps-core/windows";
import type { Song, Take } from "../lib/types";
import { isDetachablePanel, parseCommand, type Command, type DetachablePanel, type SharedState } from "./protocol";

export interface Store<T> {
  getState(): T;
  subscribe(listener: () => void): () => void;
}

export interface PlayerPort {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  transpose: number;
  playbackRate: number;
  activeTakeId: string | null;
  shownTakeIds: string[];
  takePlayback: "all" | "selected";
  mutedTakeIds: string[];
  soloedTakeId: string | null;
  muteTakesWhileRecording: boolean;
  isRecording: boolean;
  takes: Take[];
  seek(time: number): void;
  toggleTake(id: string): void;
  deleteTake(id: string): Promise<void>;
  renameTake(id: string, name: string): Promise<void>;
}

export interface MainBridgeDeps {
  player: Store<PlayerPort>;
  emit: (event: string, payload: unknown) => void | Promise<void>;
  listen: (event: string, cb: (payload: unknown) => void) => Promise<() => void>;
  now: () => number;
  /** The main take mute is on, or another track is soloed: no take is heard. */
  takesSilenced: () => boolean;
}

function applyCommand(p: PlayerPort, command: Command): void {
  switch (command.type) {
    case "seek":
      p.seek(command.time);
      break;
    case "toggleTake":
    case "deleteTake":
    case "renameTake": {
      if (!p.takes.some((t) => t.id === command.id)) {
        console.warn(`[detached] ${command.type} names a take that does not exist:`, command.id);
        break;
      }
      if (command.type === "toggleTake") p.toggleTake(command.id);
      else if (command.type === "deleteTake") {
        p.deleteTake(command.id).catch((e: unknown) => console.error("[detached] could not delete the take:", e));
      } else {
        p.renameTake(command.id, command.name).catch((e: unknown) =>
          console.error("[detached] could not rename the take:", e),
        );
      }
      break;
    }
  }
}

/**
 * The analyzer page's side of the window bridge: what its detached panels
 * receive and the few commands they may send back. The generic plumbing is
 * mps-core; this supplies the shared state and the app's commands.
 */
export function startMainBridge(deps: MainBridgeDeps): Promise<{ dispose(): void }> {
  const { player } = deps;
  return startCoreBridge<DetachablePanel, SharedState, Command>({
    isPanel: isDetachablePanel,
    subscribe: (listener) => player.subscribe(listener),
    transport: () => {
      const p = player.getState();
      return { time: p.currentTime, playing: p.isPlaying, rate: p.playbackRate };
    },
    shared: () => {
      const p = player.getState();
      return {
        song: p.song,
        duration: p.duration,
        transpose: p.transpose,
        activeTakeId: p.activeTakeId,
        shownTakeIds: p.shownTakeIds,
        takePlayback: p.takePlayback,
        mutedTakeIds: p.mutedTakeIds,
        soloedTakeId: p.soloedTakeId,
        takesSilenced: deps.takesSilenced(),
        muteTakesWhileRecording: p.muteTakesWhileRecording,
        isRecording: p.isRecording,
        takes: p.takes,
      };
    },
    parseCommand,
    apply: (command) => applyCommand(player.getState(), command),
    emit: deps.emit,
    listen: deps.listen,
    now: deps.now,
  });
}
