import { CLICK_DENSITIES, type BarMap, type ClickDensity } from "@giamat90/mps-core/meter";
import { isChordDetail, type ChordDetail } from "../lib/chordNames";
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
import type { TapSession } from "../stores/player/types";

export { EVT_COMMAND, EVT_DOCKED, EVT_HELLO, EVT_STATE };

/** main → detached: the drum hit envelope the Meter draws under the bars (the main window has the decoded stems). */
export const EVT_ENVELOPE = "mps:envelope";
export type { TransportSnapshot };

/** Every optional panel of the analyzer page. Must match `plan` in src-tauri/src/windows.rs. */
export const DETACHABLE_PANELS = ["chords", "lyrics", "takes", "tab", "meter"] as const;
export type DetachablePanel = (typeof DETACHABLE_PANELS)[number];

const windows = definePanelWindows<DetachablePanel>(DETACHABLE_PANELS);

export const isDetachablePanel = windows.isPanel;
export const detachedLabel = windows.label;
/** The window knows what it shows from its own label, not from anything in a URL. */
export const panelFromLabel = windows.fromLabel;

/** What the detached panels read; the waveforms, mixer and microphone stay in the main window. */
export interface SharedState {
  song: Song | null;
  duration: number;
  /** Semitones the song is shifted by; the chords are shown in that key. */
  transpose: number;
  /** Capo fret and the chords.json revision, so the detached chord display shows the same shapes. */
  capo: number;
  /** How much of each chord is shown (easy / medium / advanced). */
  chordDetail: ChordDetail;
  chordsRevision: number;
  activeTakeId: string | null;
  /** Takes with a lane on screen, in the order they were shown. */
  shownTakeIds: string[];
  /** How the shown takes are heard, the lanes muted by hand, and whether recording silences them. */
  takePlayback: "all" | "selected";
  mutedTakeIds: string[];
  /** The take soloed on its lane, if any. */
  soloedTakeId: string | null;
  /** The main take mute is on, or another track is soloed: no take is heard. */
  takesSilenced: boolean;
  muteTakesWhileRecording: boolean;
  isRecording: boolean;
  takes: Take[];
  /** The Meter's state: the bars, what is picked, and what the editor is doing. The main window owns and saves them. */
  meterMap: BarMap | null;
  meterEdited: boolean;
  meterSelected: number | null;
  meterBusy: boolean;
  meterError: string | null;
  /** How many changes Undo can take back (the entries stay in the main window). */
  meterUndoDepth: number;
  clickDensity: ClickDensity;
  tapSession: TapSession | null;
}

export type StateMessage = CoreStateMessage<SharedState>;

export type Command =
  | { type: "seek"; time: number }
  | { type: "toggleTake"; id: string }
  | { type: "deleteTake"; id: string }
  | { type: "renameTake"; id: string; name: string }
  | { type: "applyMeter"; map: BarMap; select: number | null | undefined }
  | { type: "undoMeter" | "resetMeter" | "detectMeter" | "startMeterFromGrid" | "finishTapping" | "cancelTapping" | "clearMeterError" }
  | { type: "selectBar"; index: number | null }
  | { type: "setClickDensity"; density: ClickDensity }
  | { type: "startTapping"; session: Omit<TapSession, "taps"> }
  | { type: "addTap"; time: number }
  | { type: "applyLoopRegion"; start: number; end: number };

const NAME_MAX = 200;
const BARS_MAX = 20_000;

const isIndexOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
const isDensity = (v: unknown): v is ClickDensity => (CLICK_DENSITIES as readonly unknown[]).includes(v);

/** The shape of a bar map from another window. Whether the bars make sense is `validateMap`'s to say, in the main window. */
export function isBarMap(v: unknown): v is BarMap {
  if (!isObject(v) || v.version !== 1 || !isNumber(v.end) || typeof v.source !== "string") return false;
  if (v.confidence !== undefined && !isNumber(v.confidence)) return false;
  return (
    Array.isArray(v.bars) &&
    v.bars.length <= BARS_MAX &&
    v.bars.every(
      (b) =>
        isObject(b) &&
        isNumber(b.start) &&
        isNumber(b.num) &&
        isNumber(b.den) &&
        (b.groups === undefined || (Array.isArray(b.groups) && b.groups.length <= 64 && b.groups.every(isNumber))),
    )
  );
}

const isTapKind = (v: unknown): v is TapSession["kind"] => v === "bars" || v === "beats";

function isTapSession(v: unknown): v is TapSession {
  return (
    isObject(v) &&
    isTapKind(v.kind) &&
    isNumber(v.den) &&
    isNumber(v.perBar) &&
    isNumber(v.pulse) &&
    Array.isArray(v.taps) &&
    v.taps.length <= BARS_MAX &&
    v.taps.every(isNumber)
  );
}

/** Everything crossing the window boundary is treated as untrusted input. */
export function parseCommand(value: unknown): Command | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case "seek":
      return isNumber(value.time) && value.time >= 0 ? { type: "seek", time: value.time } : null;
    case "toggleTake":
    case "deleteTake":
      return isId(value.id) ? { type: value.type, id: value.id } : null;
    case "renameTake":
      return isId(value.id) && typeof value.name === "string" && value.name.length <= NAME_MAX
        ? { type: "renameTake", id: value.id, name: value.name }
        : null;
    case "applyMeter":
      if (!isBarMap(value.map) || !(value.select === undefined || isIndexOrNull(value.select))) return null;
      return { type: "applyMeter", map: value.map, select: value.select };
    case "undoMeter":
    case "resetMeter":
    case "detectMeter":
    case "startMeterFromGrid":
    case "finishTapping":
    case "cancelTapping":
    case "clearMeterError":
      return { type: value.type };
    case "selectBar":
      return isIndexOrNull(value.index) ? { type: "selectBar", index: value.index } : null;
    case "setClickDensity":
      return isDensity(value.density) ? { type: "setClickDensity", density: value.density } : null;
    case "startTapping": {
      const s = value.session;
      if (!isObject(s) || !isTapKind(s.kind) || !isNumber(s.den) || !isNumber(s.perBar) || !isNumber(s.pulse)) return null;
      return { type: "startTapping", session: { kind: s.kind, den: s.den, perBar: s.perBar, pulse: s.pulse } };
    }
    case "addTap":
      return isNumber(value.time) && value.time >= 0 ? { type: "addTap", time: value.time } : null;
    case "applyLoopRegion":
      return isNumber(value.start) && isNumber(value.end) && value.start >= 0 && value.end > value.start
        ? { type: "applyLoopRegion", start: value.start, end: value.end }
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
    isNumber(value.transpose) &&
    isNumber(value.capo) &&
    isChordDetail(value.chordDetail) &&
    isNumber(value.chordsRevision) &&
    isStringOrNull(value.activeTakeId) &&
    Array.isArray(value.shownTakeIds) &&
    value.shownTakeIds.every(isId) &&
    (value.takePlayback === "all" || value.takePlayback === "selected") &&
    Array.isArray(value.mutedTakeIds) &&
    value.mutedTakeIds.every(isId) &&
    isStringOrNull(value.soloedTakeId) &&
    typeof value.takesSilenced === "boolean" &&
    typeof value.muteTakesWhileRecording === "boolean" &&
    typeof value.isRecording === "boolean" &&
    Array.isArray(value.takes) &&
    value.takes.every((t) => isObject(t) && isId(t.id)) &&
    (value.meterMap === null || isBarMap(value.meterMap)) &&
    typeof value.meterEdited === "boolean" &&
    isIndexOrNull(value.meterSelected) &&
    typeof value.meterBusy === "boolean" &&
    isStringOrNull(value.meterError) &&
    isNumber(value.meterUndoDepth) &&
    isDensity(value.clickDensity) &&
    (value.tapSession === null || isTapSession(value.tapSession))
  );
}

export function isStateMessage(value: unknown): value is StateMessage {
  return isCoreStateMessage(value, isSharedState);
}
