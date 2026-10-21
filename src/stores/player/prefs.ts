import { CLICK_DENSITIES, type ClickDensity } from "@giamat90/mps-core/meter";
import type { TakePlayback } from "@giamat90/mps-core/takes";
import { isChordDetail, type ChordDetail } from "../../lib/chordNames";
import type { CalibrationEntry } from "./types";

const OFFSETS_KEY = "songpracticestudio_recording_offsets";

export function loadOffsets(): Record<string, CalibrationEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? "{}") as Record<string, unknown>;
    const offsets: Record<string, CalibrationEntry> = {};
    for (const [deviceId, value] of Object.entries(raw)) {
      // Legacy schema stored a plain number per device.
      if (typeof value === "number") {
        offsets[deviceId] = { offset: value };
      } else if (
        value !== null &&
        typeof value === "object" &&
        typeof (value as CalibrationEntry).offset === "number"
      ) {
        offsets[deviceId] = value as CalibrationEntry;
      } else {
        console.warn("[settings] Dropping malformed recording offset entry:", deviceId, value);
      }
    }
    return offsets;
  } catch (e) {
    console.warn("[settings] Could not load recording offsets:", e);
    return {};
  }
}

export function persistOffsets(offsets: Record<string, CalibrationEntry>): void {
  try {
    localStorage.setItem(OFFSETS_KEY, JSON.stringify(offsets));
  } catch (e) {
    console.warn("[settings] Could not persist recording offsets:", e);
  }
}

// The two choices about takes that outlive a session: how shown takes are heard,
// and whether they are muted while a new one is recorded.
const TAKE_PREFS_KEY = "sps_take_prefs";

export interface TakePrefs {
  takePlayback: TakePlayback;
  muteTakesWhileRecording: boolean;
}

const DEFAULT_TAKE_PREFS: TakePrefs = {
  takePlayback: "all",
  muteTakesWhileRecording: true,
};

export function loadTakePrefs(): TakePrefs {
  try {
    const raw = localStorage.getItem(TAKE_PREFS_KEY);
    if (raw === null) return DEFAULT_TAKE_PREFS;
    const v = JSON.parse(raw) as { takePlayback?: unknown; muteTakesWhileRecording?: unknown } | null;
    return {
      takePlayback: v?.takePlayback === "selected" ? "selected" : "all",
      muteTakesWhileRecording:
        typeof v?.muteTakesWhileRecording === "boolean" ? v.muteTakesWhileRecording : DEFAULT_TAKE_PREFS.muteTakesWhileRecording,
    };
  } catch (e) {
    console.warn("[player] could not read the take preferences:", e);
    return DEFAULT_TAKE_PREFS;
  }
}

export function persistTakePrefs(prefs: TakePrefs): void {
  try {
    localStorage.setItem(TAKE_PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    console.warn("[player] could not save the take preferences:", e);
  }
}

const CHORD_DETAIL_KEY = "sps_chord_detail";

export function readChordDetail(): ChordDetail {
  try {
    const raw = localStorage.getItem(CHORD_DETAIL_KEY);
    return isChordDetail(raw) ? raw : "advanced";
  } catch (e) {
    console.warn("[player] could not read the saved chord detail:", e);
    return "advanced";
  }
}

export function persistChordDetail(detail: ChordDetail): void {
  try {
    localStorage.setItem(CHORD_DETAIL_KEY, detail);
  } catch (e) {
    console.warn("[player] could not save the chord detail:", e);
  }
}

const CAPO_KEY = "sps_capo_by_song";
export const MAX_CAPO_FRET = 7;

export function clampCapo(fret: number): number {
  return Math.max(0, Math.min(MAX_CAPO_FRET, Math.round(fret)));
}

export function readCapos(): Record<string, number> {
  try {
    const raw = localStorage.getItem(CAPO_KEY);
    if (raw === null) return {};
    const v = JSON.parse(raw) as unknown;
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch (e) {
    console.warn("[player] could not read the saved capo frets:", e);
    return {};
  }
}

export function writeCapo(songId: string, fret: number): void {
  const all = readCapos();
  if (fret > 0) all[songId] = fret;
  else delete all[songId];
  try {
    localStorage.setItem(CAPO_KEY, JSON.stringify(all));
  } catch (e) {
    console.warn("[player] could not save the capo fret:", e);
  }
}

const CLICK_DENSITY_KEY = "sps_click_density";

export function readClickDensity(): ClickDensity {
  try {
    const raw = localStorage.getItem(CLICK_DENSITY_KEY);
    return CLICK_DENSITIES.find((d) => d === raw) ?? "pulses";
  } catch (e) {
    console.warn("[settings] Could not read the click density:", e);
    return "pulses";
  }
}

export function persistClickDensity(density: ClickDensity): void {
  try {
    localStorage.setItem(CLICK_DENSITY_KEY, density);
  } catch (e) {
    console.warn("[settings] Could not persist the click density:", e);
  }
}
