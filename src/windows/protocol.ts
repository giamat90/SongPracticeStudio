import {
  EVT_COMMAND,
  EVT_DOCKED,
  EVT_HELLO,
  EVT_STATE,
  definePanelWindows,
  isId,
  isNumber,
  isObject,
  isObjectOrNull,
  isStateMessage as isCoreStateMessage,
  isStringOrNull,
  type StateMessage as CoreStateMessage,
  type TransportSnapshot,
} from "@giamat90/mps-core/windows";
import type { Song, Take } from "../lib/types";

export { EVT_COMMAND, EVT_DOCKED, EVT_HELLO, EVT_STATE };
export type { TransportSnapshot };

/** Every optional panel of the analyzer page. Must match `plan` in src-tauri/src/windows.rs. */
export const DETACHABLE_PANELS = ["chords", "lyrics", "takes"] as const;
export type DetachablePanel = (typeof DETACHABLE_PANELS)[number];

const windows = definePanelWindows<DetachablePanel>(DETACHABLE_PANELS);

export const isDetachablePanel = windows.isPanel;
export const detachedLabel = windows.label;
/** The window knows what it shows from its own label, not from anything in a URL. */
export const panelFromLabel = windows.fromLabel;

/** What the three panels read; the waveforms, mixer and microphone stay in the main window. */
export interface SharedState {
  song: Song | null;
  duration: number;
  activeTakeId: string | null;
  takes: Take[];
}

export type StateMessage = CoreStateMessage<SharedState>;

export type Command =
  | { type: "seek"; time: number }
  | { type: "setActiveTake"; id: string }
  | { type: "deleteTake"; id: string }
  | { type: "renameTake"; id: string; name: string };

const NAME_MAX = 200;

/** Everything crossing the window boundary is treated as untrusted input. */
export function parseCommand(value: unknown): Command | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "seek":
      return isNumber(value.time) && value.time >= 0 ? { type: "seek", time: value.time } : null;
    case "setActiveTake":
    case "deleteTake":
      return isId(value.id) ? { type: value.type, id: value.id } : null;
    case "renameTake":
      return isId(value.id) && typeof value.name === "string" && value.name.length <= NAME_MAX
        ? { type: "renameTake", id: value.id, name: value.name }
        : null;
    default:
      return null;
  }
}

export function isSharedState(value: unknown): value is SharedState {
  if (!isObject(value)) return false;
  return (
    isObjectOrNull(value.song) &&
    isNumber(value.duration) &&
    isStringOrNull(value.activeTakeId) &&
    Array.isArray(value.takes) &&
    value.takes.every((t) => isObject(t) && isId(t.id))
  );
}

export function isStateMessage(value: unknown): value is StateMessage {
  return isCoreStateMessage(value, isSharedState);
}
