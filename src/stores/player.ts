import { create } from "zustand";
import { AudioEngine } from "../audio/engine";
import { VocalRecorder } from "../audio/recorder";
import type { Song, Take } from "../lib/types";
import { saveTake, listTakes, deleteTakeApi, pitchShiftSong } from "../lib/tauri";

// Singletons outside Zustand
let engine: AudioEngine | null = null;
let recorder: VocalRecorder | null = null;
// Captured when recording starts so stopRecording can pass it to saveTake
let recordingStartPos = 0;

export function getEngine(): AudioEngine {
  if (!engine) {
    engine = new AudioEngine();
  }
  return engine;
}

function getRecorder(): VocalRecorder {
  if (!recorder) {
    recorder = new VocalRecorder();
  }
  return recorder;
}

interface PlayerState {
  song: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  vocalsVolume: number;
  instrumentalVolume: number;
  loopStart: number | null;
  loopEnd: number | null;
  isLooping: boolean;
  // Audio device state
  audioDevices: MediaDeviceInfo[];
  selectedDeviceId: string | null;
  outputDevices: MediaDeviceInfo[];
  selectedOutputDeviceId: string | null;
  // Transpose state
  transpose: number;
  isTransposing: boolean;
  // Recording state
  isRecording: boolean;
  takes: Take[];
  activeTakeId: string | null;
  takeVolume: number;
  // Punch-in / punch-out region (null = not set)
  punchIn: number | null;
  punchOut: number | null;
  punchLoop: boolean;
}

interface PlayerActions {
  loadSong: (
    song: Song,
    vocalsEl: HTMLElement,
    instrumentalEl: HTMLElement,
  ) => Promise<void>;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  stop: () => void;
  seek: (time: number) => void;
  setPlaybackRate: (rate: number) => void;
  setVocalsVolume: (v: number) => void;
  setInstrumentalVolume: (v: number) => void;
  setLoopPoints: (start: number, end: number) => void;
  toggleLoop: () => void;
  clearLoop: () => void;
  cleanup: () => void;
  // Audio device actions
  fetchAudioDevices: () => Promise<void>;
  setAudioDevice: (deviceId: string | null) => void;
  fetchOutputDevices: () => Promise<void>;
  setOutputDevice: (deviceId: string | null) => Promise<void>;
  // Transpose action
  setTranspose: (semitones: number) => Promise<void>;
  // Recording actions
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<void>;
  fetchTakes: () => Promise<void>;
  deleteTake: (takeId: string) => Promise<void>;
  setActiveTake: (takeId: string) => void;
  setTakeVolume: (v: number) => void;
  // Punch region actions
  setPunchIn: (t: number) => void;
  setPunchOut: (t: number) => void;
  clearPunch: () => void;
  setPunchLoop: (v: boolean) => void;
}

export const usePlayerStore = create<PlayerState & PlayerActions>((set, get) => ({
  song: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  playbackRate: 1.0,
  vocalsVolume: 1.0,
  instrumentalVolume: 1.0,
  loopStart: null,
  loopEnd: null,
  isLooping: false,
  audioDevices: [],
  selectedDeviceId: null,
  outputDevices: [],
  selectedOutputDeviceId: null,
  transpose: 0,
  isTransposing: false,
  isRecording: false,
  takes: [],
  activeTakeId: null,
  takeVolume: 1.0,
  punchIn: null,
  punchOut: null,
  punchLoop: false,

  loadSong: async (song, vocalsEl, instrumentalEl) => {
    const eng = getEngine();
    await eng.load(song.directory, vocalsEl, instrumentalEl);
    eng.onTimeUpdate((time) => {
      set({ currentTime: time, isPlaying: eng.isPlaying });
      const s = get();
      if (s.punchOut !== null && time >= s.punchOut) {
        if (s.isRecording) {
          // Auto-stop recording at punch-out
          s.stopRecording().catch((e: unknown) =>
            console.error("[player] punch-out auto-stop failed:", e)
          );
        } else if (s.isPlaying) {
          if (s.punchLoop && s.punchIn !== null) {
            // Loop: jump back to punch-in and keep playing
            eng.seekTo(s.punchIn);
            set({ currentTime: s.punchIn });
          } else {
            // Stop and rewind to punch-in
            eng.pause();
            const backTo = s.punchIn ?? 0;
            eng.seekTo(backTo);
            set({ isPlaying: false, currentTime: backTo });
          }
        }
      }
    });
    eng.onFinish(() => {
      set({ isPlaying: false });
      if (get().isRecording) {
        get().stopRecording().catch((e: unknown) =>
          console.error("[player] auto-stop recording failed:", e)
        );
      }
    });
    set({
      song,
      duration: eng.getDuration(),
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      loopStart: null,
      loopEnd: null,
      isLooping: false,
      transpose: 0,
      isTransposing: false,
      isRecording: false,
      activeTakeId: null,
    });
  },

  play: () => {
    const eng = getEngine();
    const { punchIn } = get();
    if (punchIn !== null) {
      eng.seekTo(punchIn);
      set({ currentTime: punchIn });
    }
    eng.play();
    set({ isPlaying: true });
  },

  pause: () => {
    getEngine().pause();
    set({ isPlaying: false });
  },

  togglePlay: () => {
    if (get().isPlaying) {
      get().pause();
    } else {
      get().play();
    }
  },

  stop: () => {
    getEngine().stop();
    set({ isPlaying: false, currentTime: 0 });
  },

  seek: (time) => {
    if (get().isRecording) return;
    getEngine().seekTo(time);
    set({ currentTime: time });
  },

  setPlaybackRate: (rate) => {
    getEngine().setPlaybackRate(rate);
    set({ playbackRate: rate });
  },

  setVocalsVolume: (v) => {
    getEngine().setVocalsVolume(v);
    set({ vocalsVolume: v });
  },

  setInstrumentalVolume: (v) => {
    getEngine().setInstrumentalVolume(v);
    set({ instrumentalVolume: v });
  },

  setLoopPoints: (start, end) => {
    const eng = getEngine();
    eng.setLoop(start, end);
    set({ loopStart: start, loopEnd: end, isLooping: true });
  },

  toggleLoop: () => {
    const { isLooping, loopStart, loopEnd } = get();
    const eng = getEngine();
    if (isLooping) {
      eng.clearLoop();
      set({ isLooping: false });
    } else if (loopStart !== null && loopEnd !== null) {
      eng.setLoop(loopStart, loopEnd);
      set({ isLooping: true });
    }
  },

  clearLoop: () => {
    getEngine().clearLoop();
    set({ loopStart: null, loopEnd: null, isLooping: false });
  },

  cleanup: () => {
    getEngine().destroy();
    getRecorder().dispose();
    set({
      song: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      audioDevices: [],
      outputDevices: [],
      transpose: 0,
      isTransposing: false,
      isRecording: false,
      takes: [],
      activeTakeId: null,
    });
  },

  fetchAudioDevices: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
  },

  setAudioDevice: (deviceId) => {
    set({ selectedDeviceId: deviceId });
  },

  fetchOutputDevices: async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    set({ outputDevices: devices.filter((d) => d.kind === "audiooutput") });
  },

  setOutputDevice: async (deviceId) => {
    await getEngine().setOutputDevice(deviceId ?? "");
    set({ selectedOutputDeviceId: deviceId });
  },

  setTranspose: async (semitones) => {
    const { song } = get();
    if (!song) return;

    getEngine().pause();
    set({ isTransposing: true, isPlaying: false });

    try {
      let vocalsPath: string;
      let instrumentalPath: string;

      if (semitones === 0) {
        const dir = song.directory.replace(/\\/g, "/");
        vocalsPath = dir + "/vocals.wav";
        instrumentalPath = dir + "/instrumental.wav";
      } else {
        const result = await pitchShiftSong(song.directory, semitones);
        vocalsPath = result.vocalsPath;
        instrumentalPath = result.instrumentalPath;
      }

      const eng = getEngine();
      eng.loadVocalsFromPath(vocalsPath);
      eng.loadInstrumentalFromPath(instrumentalPath);
      set({ transpose: semitones, isTransposing: false });
    } catch (e) {
      set({ isTransposing: false });
      throw e;
    }
  },

  startRecording: async () => {
    const { song } = get();
    if (!song) return;

    // Pause and capture position before getUserMedia — the audio session
    // reconfigures when the mic opens, which can stall already-playing elements.
    // Pausing first guarantees a clean seekTo+play restart after the mic is ready.
    const eng = getEngine();
    // Honour punch-in: start recording from the punch point, not the playhead
    recordingStartPos = get().punchIn ?? eng.getCurrentTime();
    eng.pause();

    const rec = getRecorder();
    try {
      await rec.init(get().selectedDeviceId);
      // Re-enumerate after getUserMedia succeeds — browser now populates device labels
      const devices = await navigator.mediaDevices.enumerateDevices();
      set({ audioDevices: devices.filter((d) => d.kind === "audioinput") });
    } catch (e) {
      eng.setInteract(true);
      throw new Error("Microphone unavailable: " + (e instanceof Error ? e.message : String(e)));
    }

    // After getUserMedia, Windows may switch the "default" audio endpoint to the
    // Communications device. Explicitly pin output to a non-Communications device
    // so the singer hears the instrumental through the regular headphone output.
    // After getUserMedia Windows may switch the "Default" audio alias to the
    // Communications endpoint, so sinkId="" routes to the wrong device.
    // Identify the real hardware output by:
    //   1. excluding Default/Communications aliases and virtual (Steam) devices
    //   2. preferring the device that shares an interface token with the selected mic
    const allDevices = await navigator.mediaDevices.enumerateDevices();
    const outputs = allDevices.filter((d) => d.kind === "audiooutput");
    const selectedInputLabel = (
      allDevices.find(
        (d) => d.kind === "audioinput" && d.deviceId === get().selectedDeviceId,
      )?.label ?? ""
    ).toUpperCase();

    const realOutputs = outputs.filter(
      (d) =>
        !d.label.startsWith("Default -") &&
        !d.label.startsWith("Communications -") &&
        !d.label.toLowerCase().includes("steam"),
    );
    const matchedOutput =
      realOutputs.find((d) =>
        d.label
          .toUpperCase()
          .split(/\W+/)
          .some((token) => token.length >= 4 && selectedInputLabel.includes(token)),
      ) ?? realOutputs[0];

    const outputId = get().selectedOutputDeviceId ?? matchedOutput?.deviceId ?? "";
    try {
      await eng.setOutputDevice(outputId);
    } catch (e) {
      console.warn("[recording] setOutputDevice failed:", e);
    }

    eng.setInteract(false);
    eng.seekTo(recordingStartPos);
    eng.play();
    rec.start();

    set({ isRecording: true, isPlaying: true });
  },

  stopRecording: async () => {
    const { song } = get();
    if (!song) return;

    const rec = getRecorder();
    const eng = getEngine();
    eng.stop();
    eng.setInteract(true);

    try {
      const blob = await rec.stop();

      // Release mic tracks so Windows exits communication mode and restores
      // the default audio endpoint back to the regular speakers output.
      rec.releaseStream();
      // Restore output routing to the user's selection (or system default).
      await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch(() => {});

      // Convert blob to byte array for Tauri
      const arrayBuffer = await blob.arrayBuffer();
      const audioData = Array.from(new Uint8Array(arrayBuffer));

      const take = await saveTake(song.id, audioData, recordingStartPos);

      // Auto-select the new take — Waveform loads it into the take track.
      set((state) => ({
        isRecording: false,
        isPlaying: false,
        currentTime: 0,
        takes: [...state.takes, take],
        activeTakeId: take.id,
      }));
    } catch (e) {
      rec.releaseStream();
      await eng.setOutputDevice(get().selectedOutputDeviceId ?? "").catch(() => {});
      set({ isRecording: false, isPlaying: false, currentTime: 0 });
      throw e;
    }
  },

  fetchTakes: async () => {
    const { song } = get();
    if (!song) return;
    const takes = await listTakes(song.id);
    set({ takes });
  },

  deleteTake: async (takeId) => {
    const { song, activeTakeId } = get();
    if (!song) return;
    await deleteTakeApi(song.id, takeId);
    set((state) => ({
      takes: state.takes.filter((t) => t.id !== takeId),
      activeTakeId: activeTakeId === takeId ? null : activeTakeId,
    }));
  },

  setActiveTake: (takeId) => {
    set({ activeTakeId: takeId });
  },

  setTakeVolume: (v) => {
    getEngine().setTakeVolume(v);
    set({ takeVolume: v });
  },

  setPunchIn:   (t) => set({ punchIn: t }),
  setPunchOut:  (t) => set({ punchOut: t }),
  clearPunch:   ()  => set({ punchIn: null, punchOut: null, punchLoop: false }),
  setPunchLoop: (v) => set({ punchLoop: v }),
}));
