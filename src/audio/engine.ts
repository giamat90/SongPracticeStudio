import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { clamp, FOLLOW_MARGIN_RATIO, FOLLOW_RESUME_SUPPRESS_MS } from "@giamat90/mps-core/zoomPan";

export type TimeUpdateCallback = (currentTime: number) => void;
export type FinishCallback = () => void;
export type ScrollChangeCallback = (minPxPerSec: number, scrollTime: number) => void;

const DRIFT_TOLERANCE_S = 0.05;
const DRIFT_CHECK_INTERVAL_MS = 250;

export const STEM_COLORS: Record<string, string> = {
  vocals: "rgba(74,158,255,0.85)",
  drums:  "rgba(180,80,220,0.85)",
  bass:   "rgba(60,200,100,0.85)",
  guitar: "rgba(255,140,30,0.85)",
  piano:  "rgba(255,220,50,0.85)",
  other:  "rgba(160,160,160,0.85)",
};

// One recorded take on the timeline. Several can be loaded at once; only the
// active one is audible (the others keep playing silently so switching is
// instant and they stay in sync).
interface TakeTrack {
  id: string;
  ws: WaveSurfer;
  // Where the take starts in the song, the audio-file skip, and the user's drag nudge
  offset: number;
  duration: number;
  audioOffset: number;
  manualOffset: number;
  // Whether this WaveSurfer is currently playing (managed by window sync)
  isPlaying: boolean;
  // Rail container, retained so zoom/pan can re-resize it later
  container: HTMLElement;
}

export class AudioEngine {
  private _stems: Map<string, WaveSurfer> = new Map();
  private _master: WaveSurfer | null = null;
  private _duration = 0;
  private _loadToken = 0;
  private _isPlaying = false;
  private _loopStart: number | null = null;
  private _loopEnd: number | null = null;
  private _timeUpdateCb: TimeUpdateCallback | null = null;
  private _finishCb: FinishCallback | null = null;
  private _rafId: number | null = null;
  private _lastNotifyTime = 0;

  // Remembered so newly-created WaveSurfer instances (new song load, new take
  // load) inherit the user's choice instead of defaulting to the system output.
  private _outputDeviceId = "";

  // Same reasoning as _outputDeviceId: a take is created on every load
  // (loadTakeTrack), so without remembering the last-set rate a freshly loaded
  // take silently reset to 1x even while playing at a non-default speed.
  private _lastPlaybackRate = 1;

  // A volume-0 <audio> element is not guaranteed to stay locked to the audio-device
  // clock like an audible one, so a muted stem drifts ahead of the audible ones.
  // Tracked so _correctDrift uses an audible stem as the reference and pulls the
  // silent ones toward it, never the other way round.
  private _silentStems = new Set<string>();
  private _lastDriftCheckAt = 0;

  // Recorded takes — separate from the stems map since their duration/start
  // position can differ from the shared song timeline (e.g. punch-in takes).
  private _takes = new Map<string, TakeTrack>();
  // The selected take (what getTrackSamples reads) and the takes that are heard.
  // They are independent: several takes can be heard together.
  private _activeTakeId: string | null = null;
  private _audibleTakeIds = new Set<string>();
  // Effective volume of the audible takes (mute/solo already applied by the store),
  // and each take's own gain on top of it (1 when none was set)
  private _takeVolume = 1;
  private _takeGains = new Map<string, number>();
  // Timeline zoom/pan
  private _minPxPerSec = 1;
  private _scrollTime = 0;
  private _lastManualScrollAt = 0;
  private _scrollUpdateCb: ScrollChangeCallback | null = null;

  async load(
    songDir: string,
    stemNames: string[],
    containers: Record<string, HTMLElement>,
  ): Promise<boolean> {
    this.destroy();
    const token = this._loadToken;

    const dir = songDir.replace(/\\/g, "/");

    const promises = stemNames.map((name) => {
      const container = containers[name];
      if (!container) return Promise.resolve();

      const color = STEM_COLORS[name] ?? "rgba(160,160,160,0.85)";
      const ws = WaveSurfer.create({
        container,
        url: convertFileSrc(`${dir}/${name}.wav`),
        height: 64,
        waveColor: color,
        progressColor: color,
        cursorColor: "#fbbf24",
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
        hideScrollbar: true,
        autoScroll: false,
        autoCenter: false,
      });
      this._stems.set(name, ws);
      ws.setSinkId(this._outputDeviceId).catch((e: unknown) =>
        console.warn(`[engine] setSinkId failed for stem "${name}":`, e)
      );

      return new Promise<void>((resolve, reject) => {
        ws.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ws.on("error", (err: any) =>
          reject(new Error(`${name} failed to load: ${err?.message ?? err}`))
        );
      });
    });

    await Promise.all(promises);
    // destroy() or a newer load() replaced these stems during the await (React
    // StrictMode runs the load effect twice). A non-empty stem map is not proof
    // of that: the newer load's still-undecoded stems would pass, size the
    // song to 0, and make zoom() throw "No audio loaded".
    if (token !== this._loadToken) return false;
    if (this._stems.size === 0) return true;

    // Master clock: prefer vocals, otherwise use first available stem
    const masterName = this._stems.has("vocals") ? "vocals" : stemNames.find((n) => this._stems.has(n))!;
    this._master = this._stems.get(masterName)!;
    this._duration = this._master.getDuration();

    // Sync: clicking any stem waveform seeks all others (and the take, if loaded)
    for (const [name, ws] of this._stems) {
      ws.on("interaction", (time) => {
        const progress = Math.max(0, Math.min(1, time / this._duration));
        for (const [otherName, other] of this._stems) {
          if (otherName !== name) other.seekTo(progress);
        }
        this._seekTake(time);
        this._notifySeek(time);
      });
    }

    this._master.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
      this._finishCb?.();
    });
    return true;
  }

  // Swaps each already-loaded stem's underlying audio file in place (used by
  // transpose) instead of destroying/recreating instances, so containers,
  // volumes, and the take/zoom state stay untouched. Mirrors VPS's
  // loadVocalsFromPath/loadInstrumentalFromPath, generalized to the dynamic
  // stems Map.
  async reloadStemsFromPaths(paths: Record<string, string>): Promise<void> {
    if (this._stems.size === 0) return;
    const time = this.getCurrentTime();
    const wasPlaying = this._isPlaying;
    if (wasPlaying) this.pause();

    const promises = [...this._stems.entries()].map(([name, ws]) => {
      const path = paths[name];
      if (!path) return Promise.resolve();
      const url = convertFileSrc(path.replace(/\\/g, "/"));
      return new Promise<void>((resolve, reject) => {
        const unsubReady = ws.on("ready", () => { unsubReady(); unsubError(); resolve(); });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsubError = ws.on("error", (err: any) => {
          unsubReady(); unsubError();
          reject(new Error(`${name} failed to reload: ${err?.message ?? err}`));
        });
        ws.load(url);
      });
    });

    await Promise.all(promises);
    if (this._master) this._duration = this._master.getDuration();
    this.seekTo(time);
    if (wasPlaying) this.play();
  }

  play(): void {
    if (this._stems.size === 0) return;
    for (const ws of this._stems.values()) ws.play();
    const time = this.getCurrentTime();
    for (const t of this._takes.values()) {
      if (t.duration > 0 && this._inWindow(t, time)) {
        t.ws.play();
        t.isPlaying = true;
      }
    }
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pause(): void {
    for (const ws of this._stems.values()) ws.pause();
    for (const t of this._takes.values()) {
      t.ws.pause();
      t.isPlaying = false;
    }
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  togglePlay(): void {
    if (this._isPlaying) this.pause();
    else this.play();
  }

  stop(): void {
    this.pause();
    this.seekTo(0);
  }

  seekTo(time: number): void {
    const progress = Math.max(0, Math.min(1, time / this._duration));
    for (const ws of this._stems.values()) ws.seekTo(progress);
    this._seekTake(time);
  }

  // The rAF tick is the only other source of time updates and it stops while
  // paused, so without this a click on a waveform would move the audio but
  // leave the time readout and the lyrics on the old position until Play.
  private _notifySeek(time: number): void {
    this._timeUpdateCb?.(Math.max(0, Math.min(this._duration, time)));
  }

  setStemVolume(name: string, volume: number): void {
    if (volume <= 0) this._silentStems.add(name);
    else this._silentStems.delete(name);
    this._stems.get(name)?.setVolume(volume);
  }

  setPlaybackRate(rate: number): void {
    this._lastPlaybackRate = rate;
    for (const ws of this._stems.values()) ws.setPlaybackRate(rate);
    for (const t of this._takes.values()) t.ws.setPlaybackRate(rate);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this._outputDeviceId = deviceId;
    await Promise.all([
      ...[...this._stems.values()].map((ws) => ws.setSinkId(deviceId)),
      ...[...this._takes.values()].map((t) => t.ws.setSinkId(deviceId)),
    ]);
  }

  /** Enable/disable click-to-seek on stem waveforms (disabled while recording). */
  setInteract(enabled: boolean): void {
    for (const ws of this._stems.values()) ws.setOptions({ interact: enabled });
    for (const t of this._takes.values()) t.ws.setOptions({ interact: enabled });
  }

  async loadTakeTrack(
    id: string,
    filePath: string,
    container: HTMLElement,
    startOffset = 0,
    audioOffset = 0,
    manualOffset = 0,
  ): Promise<void> {
    this.removeTakeTrack(id);

    const wasPlaying = this._isPlaying;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    const ws = WaveSurfer.create({
      container,
      url,
      height: 64,
      waveColor: "#ff8c1e",
      progressColor: "#ff8c1e",
      cursorColor: "#ff8c1e",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      hideScrollbar: true,
      autoScroll: false,
      autoCenter: false,
    });
    const track: TakeTrack = {
      id, ws, offset: startOffset, duration: 0, audioOffset, manualOffset, isPlaying: false, container,
    };
    this._takes.set(id, track);
    ws.setSinkId(this._outputDeviceId).catch((e: unknown) =>
      console.warn("[engine] setSinkId failed for take:", e)
    );
    ws.setPlaybackRate(this._lastPlaybackRate);
    ws.setVolume(this._takeLevel(id));

    try {
      await new Promise<void>((resolve, reject) => {
        const unsubReady = ws.on("ready", () => { unsubReady(); unsubError(); resolve(); });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const unsubError = ws.on("error", (err: any) => {
          unsubReady(); unsubError();
          console.error("[engine] WaveSurfer take load failed — url:", url, "raw err:", err);
          reject(new Error(err?.message || err?.toString?.() || "WaveSurfer load error"));
        });
      });
    } catch (e) {
      if (this._takes.get(id) === track) this._takes.delete(id);
      ws.destroy();
      throw e;
    }

    // The take may have been removed (hidden, deleted, song closed) while it decoded.
    if (this._takes.get(id) !== track) {
      ws.destroy();
      return;
    }

    track.duration = ws.getDuration();

    // Constrain the container to the correct time window so the waveform
    // lines up visually with the other tracks, in absolute pixels derived
    // from the current zoom/scroll — not a fraction of the container, which
    // only worked while zoom was fixed at "whole song fills the container".
    this._resizeTakeTrack(track);

    ws.on("interaction", (newTime) => {
      const songTime = newTime - track.audioOffset + track.offset + track.manualOffset;
      this.seekTo(songTime);
      this._notifySeek(songTime);
    });

    const time = this.getCurrentTime();
    this._seekTakeTrack(track, time);
    if (wasPlaying && this._inWindow(track, time)) {
      ws.play();
      track.isPlaying = true;
    }
  }

  // Live drag preview and commit: repositions the take track visually and
  // keeps playback/seek aligned, without touching the Zustand store.
  setTakeManualOffset(id: string, offset: number): void {
    const t = this._takes.get(id);
    if (!t) return;
    t.manualOffset = offset;
    this._resizeTakeTrack(t);
    this._seekTakeTrack(t, this.getCurrentTime());
  }

  /** The take that is heard, or null. */
  get activeTakeId(): string | null {
    return this._activeTakeId;
  }

  /** The selected take: what the spectrum reads. It does not change what is heard. */
  setActiveTakeTrack(id: string | null): void {
    this._activeTakeId = id;
  }

  /** Which loaded takes are heard; the others stay loaded and in sync, silently. */
  setAudibleTakeTracks(ids: readonly string[]): void {
    this._audibleTakeIds = new Set(ids);
    this._applyTakeVolumes();
  }

  /** The effective volume of the takes that are heard (mute / solo already applied). */
  setTakeVolume(volume: number): void {
    this._takeVolume = volume;
    this._applyTakeVolumes();
  }

  /** Each take's own volume, multiplied with the take channel's. */
  setTakeGains(gains: Readonly<Record<string, number>>): void {
    this._takeGains = new Map(Object.entries(gains));
    this._applyTakeVolumes();
  }

  private _takeLevel(id: string): number {
    return this._audibleTakeIds.has(id) ? this._takeVolume * (this._takeGains.get(id) ?? 1) : 0;
  }

  private _applyTakeVolumes(): void {
    for (const t of this._takes.values()) t.ws.setVolume(this._takeLevel(t.id));
  }

  removeTakeTrack(id: string): void {
    const t = this._takes.get(id);
    if (!t) return;
    t.ws.destroy();
    this._takes.delete(id);
  }

  clearTakeTrack(): void {
    for (const t of this._takes.values()) t.ws.destroy();
    this._takes.clear();
    this._activeTakeId = null;
    this._audibleTakeIds = new Set();
    this._takeGains = new Map();
  }

  /**
   * The mono sum of the named stems between two song times, read from their decoded audio (the chord
   * spectrum panel analyses it). Null when none of them is decoded yet.
   */
  getStemSamples(names: readonly string[], start: number, end: number): { sampleRate: number; samples: Float32Array } | null {
    let sampleRate = 0;
    let out: Float32Array | null = null;
    for (const name of names) {
      const data = this._stems.get(name)?.getDecodedData();
      if (!data || (sampleRate !== 0 && data.sampleRate !== sampleRate)) continue;
      sampleRate = data.sampleRate;
      const from = Math.max(0, Math.floor(start * sampleRate));
      const to = Math.min(data.length, Math.floor(end * sampleRate));
      if (to <= from) continue;
      out ??= new Float32Array(to - from);
      for (let c = 0; c < data.numberOfChannels; c++) {
        const channel = data.getChannelData(c);
        const n = Math.min(out.length, to - from);
        for (let i = 0; i < n; i++) out[i] += channel[from + i] / data.numberOfChannels;
      }
    }
    return out ? { sampleRate, samples: out } : null;
  }

  // ─── Timeline zoom/pan ──────────────────────────────────────────────────

  /**
   * The instances zoom and scroll can be applied to. WaveSurfer throws "No audio
   * loaded" from zoom() until a file is decoded, and a take lane is in the map
   * from the moment it is created, so one that is still decoding is left out
   * (it is sized at the current zoom when it is ready, see _resizeTakeTrack).
   */
  private _allInstances(): WaveSurfer[] {
    return [...this._stems.values(), ...[...this._takes.values()].map((t) => t.ws)].filter(
      (ws) => ws.getDecodedData() !== null,
    );
  }

  // Dynamic lower zoom bound: the minPxPerSec at which the whole song
  // exactly fills the current container width (today's implicit
  // fillParent-equivalent baseline).
  getMinPxPerSec(): number {
    if (!this._master || this._duration <= 0) return 1;
    const w = this._master.getWidth();
    return w > 0 ? w / this._duration : 1;
  }

  zoomAll(minPxPerSec: number, scrollTime: number): void {
    this._minPxPerSec = minPxPerSec;
    this._scrollTime = scrollTime;
    for (const ws of this._allInstances()) {
      ws.zoom(minPxPerSec);
      ws.setScrollTime(scrollTime);
    }
    for (const t of this._takes.values()) this._resizeTakeTrack(t);
  }

  setScrollAll(scrollTime: number): void {
    this._scrollTime = scrollTime;
    for (const ws of this._allInstances()) ws.setScrollTime(scrollTime);
    for (const t of this._takes.values()) this._resizeTakeTrack(t);
  }

  // Marks the moment of a user-driven wheel zoom/pan, so the auto-follow
  // logic in the rAF tick doesn't immediately override a deliberate
  // manual pan/zoom on the very next frame.
  noteManualScrollInteraction(): void {
    this._lastManualScrollAt = performance.now();
  }

  onScrollChange(cb: ScrollChangeCallback): void {
    this._scrollUpdateCb = cb;
  }

  private _resizeTakeTrack(t: TakeTrack): void {
    if (this._duration <= 0 || t.duration <= 0) return;
    const playableDur = t.duration - t.audioOffset;
    const widthPx  = Math.round(playableDur * this._minPxPerSec);
    const marginPx = Math.round((t.offset + t.manualOffset - this._scrollTime) * this._minPxPerSec);
    t.container.style.marginLeft = `${marginPx}px`;
    t.container.style.width      = `${widthPx}px`;
    t.ws.setOptions({ width: widthPx });
  }

  // Seek every take to the position that corresponds to the given song time.
  private _seekTake(songTime: number): void {
    for (const t of this._takes.values()) this._seekTakeTrack(t, songTime);
  }

  private _seekTakeTrack(t: TakeTrack, songTime: number): void {
    const dur = t.duration > 0 ? t.duration : this._duration;
    const takeTime = t.audioOffset + Math.max(0, songTime - (t.offset + t.manualOffset));
    t.ws.seekTo(Math.min(1, takeTime / dur));
  }

  private _inWindow(t: TakeTrack, time: number): boolean {
    const start = t.offset + t.manualOffset;
    const end = start + t.duration - t.audioOffset;
    return time >= start && time < end;
  }

  setLoop(start: number, end: number): void {
    this._loopStart = start;
    this._loopEnd = end;
  }

  clearLoop(): void {
    this._loopStart = null;
    this._loopEnd = null;
  }

  getCurrentTime(): number {
    return this._master?.getCurrentTime() ?? 0;
  }

  getDuration(): number {
    return this._duration;
  }

  get isPlaying(): boolean {
    return this._isPlaying;
  }

  onTimeUpdate(cb: TimeUpdateCallback): void {
    this._timeUpdateCb = cb;
  }

  onFinish(cb: FinishCallback): void {
    this._finishCb = cb;
  }

  destroy(): void {
    this._loadToken++;
    this._stopTimeUpdate();
    for (const ws of this._stems.values()) ws.destroy();
    this._stems.clear();
    this._master = null;
    this._isPlaying = false;
    this._duration = 0;
    this._silentStems.clear();
    this._loopStart = null;
    this._loopEnd = null;
    this.clearTakeTrack();
    this._minPxPerSec = 1;
    this._scrollTime = 0;
  }

  private _startTimeUpdate(): void {
    this._stopTimeUpdate();
    const tick = () => {
      if (!this._isPlaying) return;

      const time = this.getCurrentTime();

      if (
        this._loopStart !== null &&
        this._loopEnd !== null &&
        time >= this._loopEnd
      ) {
        this.seekTo(this._loopStart);
      }

      // Take window sync: start/stop the take as the playhead enters/exits its time window
      for (const t of this._takes.values()) {
        if (t.duration <= 0) continue;
        const inWindow = this._inWindow(t, time);
        if (inWindow && !t.isPlaying) {
          t.ws.play();
          t.isPlaying = true;
        } else if (!inWindow && t.isPlaying) {
          t.ws.pause();
          t.isPlaying = false;
        }
      }

      if (performance.now() - this._lastDriftCheckAt >= DRIFT_CHECK_INTERVAL_MS) {
        this._lastDriftCheckAt = performance.now();
        this._correctDrift();
      }

      // Auto-follow: while zoomed in and playing, keep the playhead from
      // scrolling out of view, without fighting a just-made manual pan/zoom.
      const baseline = this.getMinPxPerSec();
      if (
        this._minPxPerSec > baseline + 1e-6 &&
        performance.now() - this._lastManualScrollAt > FOLLOW_RESUME_SUPPRESS_MS
      ) {
        const viewportWidthPx = this._master?.getWidth() ?? 0;
        if (viewportWidthPx > 0) {
          const visibleDur = viewportWidthPx / this._minPxPerSec;
          const maxScroll = Math.max(0, this._duration - visibleDur);
          const rightMargin = this._scrollTime + visibleDur * FOLLOW_MARGIN_RATIO;
          if (time > rightMargin) {
            this.setScrollAll(clamp(this._scrollTime + (time - rightMargin), 0, maxScroll));
            this._scrollUpdateCb?.(this._minPxPerSec, this._scrollTime);
          } else if (time < this._scrollTime) {
            this.setScrollAll(clamp(time - visibleDur * (1 - FOLLOW_MARGIN_RATIO), 0, maxScroll));
            this._scrollUpdateCb?.(this._minPxPerSec, this._scrollTime);
          }
        }
      }

      const now = performance.now();
      if (now - this._lastNotifyTime >= 33) {
        this._lastNotifyTime = now;
        this._timeUpdateCb?.(time);
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private _correctDrift(): void {
    if (!this._master) return;
    const masterEntry = [...this._stems].find(([, ws]) => ws === this._master);
    let ref = this._master;
    if (masterEntry && this._silentStems.has(masterEntry[0])) {
      const audible = [...this._stems].find(([name]) => !this._silentStems.has(name));
      if (audible) ref = audible[1];
    }
    const refTime = ref.getCurrentTime();
    for (const ws of this._stems.values()) {
      if (ws !== ref && Math.abs(ws.getCurrentTime() - refTime) > DRIFT_TOLERANCE_S) {
        ws.setTime(refTime);
      }
    }

    for (const t of this._takes.values()) {
      if (!t.isPlaying) continue;
      const expectedTake = t.audioOffset + Math.max(0, refTime - (t.offset + t.manualOffset));
      if (Math.abs(t.ws.getCurrentTime() - expectedTake) > DRIFT_TOLERANCE_S) {
        t.ws.setTime(expectedTake);
      }
    }
  }

  private _stopTimeUpdate(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
