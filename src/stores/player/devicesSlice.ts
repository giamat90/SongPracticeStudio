import { resolveSavedDevice, toSavedDevice } from "@giamat90/mps-core/audio-setup";
import { chordSynth } from "../../audio/chordSynth";
import { useSettingsStore } from "../settings";
import { loadOffsets, persistOffsets } from "./prefs";
import { getEngine } from "./singletons";
import type { CalibrationEntry, DevicesSlice, Getter, Setter, Slice } from "./types";

let deviceWatcherInit = false;
let knownDeviceIds: Set<string> | null = null;

// WebView2 on the installed tauri:// origin returns empty device labels until mic
// permission has been granted for this session. A brief probe unlocks the full list.
async function probeMicPermission(consequence: string): Promise<void> {
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    probe.getTracks().forEach((t) => t.stop());
  } catch (e) {
    console.warn(`Mic permission probe failed — ${consequence}:`, e);
  }
}

function sameIds(a: Set<string> | null, b: Set<string>): boolean {
  return a !== null && a.size === b.size && [...a].every((id) => b.has(id));
}

function markStaleCalibrations(
  offsets: Record<string, CalibrationEntry>,
  currentIds: Set<string>,
): { offsets: Record<string, CalibrationEntry>; changed: boolean } {
  const next = { ...offsets };
  let changed = false;
  for (const [inputId, entry] of Object.entries(next)) {
    if (entry.stale) continue;
    // "" is the default-microphone key, never present in enumerated ids.
    const inputGone = inputId !== "" && !currentIds.has(inputId);
    const outputGone = entry.outputDeviceId !== undefined && !currentIds.has(entry.outputDeviceId);
    if (inputGone || outputGone) {
      next[inputId] = { ...entry, stale: true };
      changed = true;
    }
  }
  return { offsets: next, changed };
}

async function applyOutput(deviceId: string): Promise<void> {
  chordSynth.setOutputDevice(deviceId);
  await getEngine().setOutputDevice(deviceId);
}

// The input and output the user picked live in the settings (one choice for every song and
// every start). Whenever the device lists are known, a pick the session does not hold yet is
// taken from there; a saved device that is not connected waits, and the system default is used.
function restoreInput(set: Setter, get: Getter): void {
  if (get().selectedDeviceId !== null) return;
  const settings = useSettingsStore.getState();
  const saved = settings.audioSetup.input;
  const { id } = resolveSavedDevice(saved, get().audioDevices);
  if (id === null) return;
  set({ selectedDeviceId: id });
  if (saved !== null && id !== saved.id) settings.setAudioInput(toSavedDevice(id, get().audioDevices));
}

async function restoreOutput(set: Setter, get: Getter): Promise<void> {
  if (get().selectedOutputDeviceId !== null) return;
  const settings = useSettingsStore.getState();
  const saved = settings.audioSetup.output;
  const { id } = resolveSavedDevice(saved, get().outputDevices);
  if (id === null) return;
  try {
    await applyOutput(id);
  } catch (e) {
    console.warn("[devices] could not restore the saved output:", e);
    return;
  }
  set({ selectedOutputDeviceId: id });
  if (saved !== null && id !== saved.id) settings.setAudioOutput(toSavedDevice(id, get().outputDevices));
}

async function handleDeviceChange(set: Setter, get: Getter): Promise<void> {
  const current = await navigator.mediaDevices.enumerateDevices();
  const currentIds = new Set(current.map((d) => d.deviceId));
  const prev = knownDeviceIds;
  knownDeviceIds = currentIds;
  // devicechange also fires for irrelevant changes (e.g. default-device
  // switches) — only act when the enumerated set actually differs.
  if (sameIds(prev, currentIds)) return;

  set({
    audioDevices: current.filter((d) => d.kind === "audioinput"),
    outputDevices: current.filter((d) => d.kind === "audiooutput"),
  });
  restoreInput(set, get);
  await restoreOutput(set, get);

  const { offsets, changed } = markStaleCalibrations(get().recordingOffsets, currentIds);
  if (changed) {
    set({ recordingOffsets: offsets });
    persistOffsets(offsets);
    console.warn("[calibration] audio device set changed — affected calibrations marked stale");
  }
}

function watchDeviceChanges(set: Setter, get: Getter): void {
  if (deviceWatcherInit) return;
  deviceWatcherInit = true;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    handleDeviceChange(set, get).catch((e: unknown) => console.warn("[calibration] devicechange handling failed:", e));
  });
}

export const createDevicesSlice: Slice<DevicesSlice> = (set, get) => ({
  audioDevices: [],
  selectedDeviceId: null,
  outputDevices: [],
  selectedOutputDeviceId: null,
  recordingOffsets: loadOffsets(),
  usedLatencyFallback: false,

  fetchAudioDevices: async () => {
    await probeMicPermission("device list may be incomplete");
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    knownDeviceIds = new Set(devices.map((d) => d.deviceId));
    restoreInput(set, get);
    watchDeviceChanges(set, get);
  },

  setAudioDevice: (deviceId) => {
    set({ selectedDeviceId: deviceId });
    useSettingsStore.getState().setAudioInput(toSavedDevice(deviceId, get().audioDevices));
  },

  setRecordingOffset: (deviceId, offsetMs) => {
    // A hand-typed value has no measured confidence — store it bare, which also
    // clears any stale flag from a previous calibration.
    const offsets = { ...get().recordingOffsets, [deviceId]: { offset: offsetMs } };
    set({ recordingOffsets: offsets });
    persistOffsets(offsets);
  },

  applyCalibration: (deviceId, entry) => {
    const offsets = { ...get().recordingOffsets, [deviceId]: entry };
    set({ recordingOffsets: offsets });
    persistOffsets(offsets);
  },

  fetchOutputDevices: async () => {
    await probeMicPermission("output device list may be incomplete");
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ outputDevices: devices.filter((d) => d.kind === "audiooutput") });
    await restoreOutput(set, get);
  },

  setOutputDevice: async (deviceId) => {
    await applyOutput(deviceId ?? "");
    set({ selectedOutputDeviceId: deviceId });
    useSettingsStore.getState().setAudioOutput(toSavedDevice(deviceId, get().outputDevices));
  },
});
