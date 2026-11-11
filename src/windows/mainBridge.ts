import { startMainBridge as startCoreBridge, type BridgeStream } from "@giamat90/mps-core/windows";
import { ENVELOPE_FPS } from "../lib/meterView";
import type { BarMap, ClickDensity } from "@giamat90/mps-core/meter";
import type { Song, Take } from "../lib/types";
import type { TapSession } from "../stores/player/types";
import { EVT_ENVELOPE, isDetachablePanel, parseCommand, type Command, type DetachablePanel, type SharedState } from "./protocol";

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
  capo: number;
  chordDetail: SharedState["chordDetail"];
  chordsRevision: number;
  playbackRate: number;
  activeTakeId: string | null;
  shownTakeIds: string[];
  takePlayback: "all" | "selected";
  mutedTakeIds: string[];
  soloedTakeId: string | null;
  muteTakesWhileRecording: boolean;
  isRecording: boolean;
  takes: Take[];
  meterMap: BarMap | null;
  meterEdited: boolean;
  meterSelected: number | null;
  meterBusy: boolean;
  meterError: string | null;
  meterHistory: readonly unknown[];
  clickDensity: ClickDensity;
  tapSession: TapSession | null;
  seek(time: number): void;
  applyMeter(map: BarMap | null, select?: number | null): Promise<void>;
  undoMeter(): Promise<void>;
  resetMeter(): Promise<void>;
  detectMeter(): Promise<void>;
  startMeterFromGrid(): Promise<void>;
  finishTapping(): Promise<void>;
  cancelTapping(): void;
  clearMeterError(): void;
  selectBar(index: number | null): void;
  setClickDensity(density: ClickDensity): void;
  startTapping(session: Omit<TapSession, "taps">): void;
  addTap(time: number): void;
  applyLoopRegion(start: number, end: number): void;
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
  /**
   * The drums' hit envelope for the song, read from the decoded stems (only this window has them). Resolves to null
   * when `cancelled()` turns true or there is nothing to read.
   */
  hitEnvelope: (song: Song, cancelled: () => boolean) => Promise<Float32Array | null>;
}

/** What `mps:envelope` carries; the values are rounded, a tenth of a percent is plenty for a line under the bars. */
export interface EnvelopeMessage {
  songId: string;
  fps: number;
  values: number[];
}

const report = (what: string) => (e: unknown) => console.error(`[detached] ${what}:`, e);

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
    case "applyMeter":
      p.applyMeter(command.map, command.select).catch(report("could not apply the bars"));
      break;
    case "undoMeter":
      p.undoMeter().catch(report("could not undo the bars"));
      break;
    case "resetMeter":
      p.resetMeter().catch(report("could not reset the bars"));
      break;
    case "detectMeter":
      p.detectMeter().catch(report("could not find the bars"));
      break;
    case "startMeterFromGrid":
      p.startMeterFromGrid().catch(report("could not start the bars from the tempo"));
      break;
    case "finishTapping":
      p.finishTapping().catch(report("could not finish tapping"));
      break;
    case "cancelTapping":
      p.cancelTapping();
      break;
    case "clearMeterError":
      p.clearMeterError();
      break;
    case "selectBar":
      p.selectBar(command.index);
      break;
    case "setClickDensity":
      p.setClickDensity(command.density);
      break;
    case "startTapping":
      p.startTapping(command.session);
      break;
    case "addTap":
      p.addTap(command.time);
      break;
    case "applyLoopRegion":
      p.applyLoopRegion(command.start, command.end);
      break;
  }
}

/** Sends the Meter window the drums' envelope when it says hello: reading it takes a moment, so it comes as its own event. */
function envelopeStream(deps: MainBridgeDeps, send: (event: string, payload: unknown) => void): BridgeStream<DetachablePanel> {
  let stop: (() => void) | null = null;
  return {
    hello(panel) {
      if (panel !== "meter") return;
      const song = deps.player.getState().song;
      if (!song) return;
      stop?.();
      let cancelled = false;
      stop = () => {
        cancelled = true;
      };
      deps
        .hitEnvelope(song, () => cancelled)
        .then((values) => {
          if (!values || cancelled) return;
          const message: EnvelopeMessage = {
            songId: song.id,
            fps: ENVELOPE_FPS,
            values: Array.from(values, (v) => Math.round(v * 1000) / 1000),
          };
          send(EVT_ENVELOPE, message);
        })
        .catch(report("could not read the drums for the Meter"));
    },
    dispose() {
      stop?.();
    },
  };
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
        capo: p.capo,
        chordDetail: p.chordDetail,
        chordsRevision: p.chordsRevision,
        activeTakeId: p.activeTakeId,
        shownTakeIds: p.shownTakeIds,
        takePlayback: p.takePlayback,
        mutedTakeIds: p.mutedTakeIds,
        soloedTakeId: p.soloedTakeId,
        takesSilenced: deps.takesSilenced(),
        muteTakesWhileRecording: p.muteTakesWhileRecording,
        isRecording: p.isRecording,
        takes: p.takes,
        meterMap: p.meterMap,
        meterEdited: p.meterEdited,
        meterSelected: p.meterSelected,
        meterBusy: p.meterBusy,
        meterError: p.meterError,
        meterUndoDepth: p.meterHistory.length,
        clickDensity: p.clickDensity,
        tapSession: p.tapSession,
      };
    },
    streams: (send) => [envelopeStream(deps, send)],
    parseCommand,
    apply: (command) => applyCommand(player.getState(), command),
    emit: deps.emit,
    listen: deps.listen,
    now: deps.now,
  });
}
