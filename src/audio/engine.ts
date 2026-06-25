import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";

export type TimeUpdateCallback = (currentTime: number) => void;
export type FinishCallback = () => void;

export class AudioEngine {
  vocals: WaveSurfer | null = null;
  instrumental: WaveSurfer | null = null;
  take: WaveSurfer | null = null;
  private _duration = 0;
  private _isPlaying = false;
  private _loopStart: number | null = null;
  private _loopEnd: number | null = null;
  private _timeUpdateCb: TimeUpdateCallback | null = null;
  private _finishCb: FinishCallback | null = null;
  private _rafId: number | null = null;
  // Throttle store updates to ~30fps — halves React re-render rate vs 60fps rAF
  private _lastNotifyTime = 0;
  // Offset (seconds) into the song where the vocals/take file starts
  private _vocalsOffset = 0;
  // Duration of the vocals/take file (may differ from _duration for partial takes)
  private _vocalsDuration = 0;
  // Take track offset and duration
  private _takeOffset = 0;
  private _takeDuration = 0;
  // Whether the take WaveSurfer is currently playing (managed by window sync)
  private _takeIsPlaying = false;

  async load(
    songDir: string,
    vocalsContainer: HTMLElement,
    instrumentalContainer: HTMLElement,
  ): Promise<void> {
    this.destroy();

    // Normalize to forward slashes so convertFileSrc works correctly on Windows
    const dir = songDir.replace(/\\/g, "/");
    const vocalsUrl = convertFileSrc(dir + "/vocals.wav");
    const instrumentalUrl = convertFileSrc(dir + "/instrumental.wav");

    const waveOptions = {
      height: 80,
      waveColor: "#a0a0b0",
      progressColor: "#e94560",
      cursorColor: "#e94560",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
    };

    this.vocals = WaveSurfer.create({
      ...waveOptions,
      container: vocalsContainer,
      url: vocalsUrl,
    });

    this.instrumental = WaveSurfer.create({
      ...waveOptions,
      container: instrumentalContainer,
      url: instrumentalUrl,
      waveColor: "#4a6fa5",
      progressColor: "#4ade80",
    });

    // Wait for both to be ready; reject immediately on WaveSurfer error
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        this.vocals!.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.vocals!.on("error", (err: any) => reject(new Error("Vocals failed to load: " + (err?.message ?? err))));
      }),
      new Promise<void>((resolve, reject) => {
        this.instrumental!.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.instrumental!.on("error", (err: any) => reject(new Error("Instrumental failed to load: " + (err?.message ?? err))));
      }),
    ]);

    // Guard: destroy() may have been called (e.g. by React StrictMode cleanup) during the await.
    if (!this.vocals || !this.instrumental) return;

    // Duration is always based on the instrumental (the reference track).
    // Vocals/take may be shorter when recording starts mid-song.
    this._duration = this.instrumental.getDuration();
    this._vocalsDuration = this.vocals.getDuration();
    this._vocalsOffset = 0;

    // Sync: when user clicks on one waveform, seek the other.
    // "interaction" fires ONLY on user clicks — never on programmatic seekTo() calls.
    // Using "seeking" (the proxied HTML5 event) here caused an infinite async loop:
    // seekTo(0) → vocals fires "seeking" → instrumental.seekTo(0) → instrumental fires
    // "seeking" → vocals.seekTo(0) → … each iteration queued a new async task,
    // growing the task queue and RAM indefinitely after every stop.
    this.vocals.on("interaction", (newTime) => {
      // Map vocals file time → instrumental song time, then seek instrumental
      const instrTime = newTime + this._vocalsOffset;
      const instrProgress = Math.max(0, Math.min(1, instrTime / this._duration));
      this.instrumental?.seekTo(instrProgress);
    });

    this.instrumental.on("interaction", (newTime) => {
      // Map instrumental song time → vocals/take file time, accounting for start offset
      this._seekVocals(newTime);
      this._seekTake(newTime);
    });

    // Finish fires on the instrumental so partial takes don't prematurely end playback
    this.instrumental.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
      this._finishCb?.();
    });
  }

  play(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.play();
    this.instrumental.play();
    if (this.take && this._takeDuration > 0) {
      const time = this.getCurrentTime();
      if (time >= this._takeOffset && time < this._takeOffset + this._takeDuration) {
        this.take.play();
        this._takeIsPlaying = true;
      }
    }
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pause(): void {
    if (!this.vocals || !this.instrumental) return;
    this.vocals.pause();
    this.instrumental.pause();
    this.take?.pause();
    this._takeIsPlaying = false;
    this._isPlaying = false;
    this._stopTimeUpdate();
  }

  togglePlay(): void {
    if (this._isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  stop(): void {
    this.pause();
    this.seekTo(0);
  }

  seekTo(time: number): void {
    if (!this.vocals || !this.instrumental) return;
    const instrProgress = Math.max(0, Math.min(1, time / this._duration));
    this.instrumental.seekTo(instrProgress);
    this._seekVocals(time);
    this._seekTake(time);
  }

  // Seek the vocals/take to the position that corresponds to the given song time.
  private _seekVocals(instrTime: number): void {
    if (!this.vocals) return;
    const dur = this._vocalsDuration > 0 ? this._vocalsDuration : this._duration;
    const vocalsTime = Math.max(0, instrTime - this._vocalsOffset);
    this.vocals.seekTo(Math.min(1, vocalsTime / dur));
  }

  private _seekTake(instrTime: number): void {
    if (!this.take) return;
    const dur = this._takeDuration > 0 ? this._takeDuration : this._duration;
    const takeTime = Math.max(0, instrTime - this._takeOffset);
    this.take.seekTo(Math.min(1, takeTime / dur));
  }

  setPlaybackRate(rate: number): void {
    this.vocals?.setPlaybackRate(rate);
    this.instrumental?.setPlaybackRate(rate);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await Promise.all([
      this.vocals?.setSinkId(deviceId),
      this.instrumental?.setSinkId(deviceId),
      this.take?.setSinkId(deviceId),
    ]);
  }

  setVocalsVolume(volume: number): void {
    this.vocals?.setVolume(volume);
  }

  setInstrumentalVolume(volume: number): void {
    this.instrumental?.setVolume(volume);
  }

  setInteract(enabled: boolean): void {
    this.vocals?.setOptions({ interact: enabled });
    this.instrumental?.setOptions({ interact: enabled });
  }

  async loadVocalsFromPath(filePath: string, startOffset = 0): Promise<void> {
    if (!this.vocals) return;
    const wasPlaying = this._isPlaying;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    await new Promise<void>((resolve, reject) => {
      const unsubReady = this.vocals!.on("ready", () => {
        unsubReady();
        unsubError();
        resolve();
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubError = this.vocals!.on("error", (err: any) => {
        unsubReady();
        unsubError();
        reject(new Error(err?.message ?? String(err)));
      });
      this.vocals!.load(url);
    });

    this._vocalsOffset = startOffset;
    this._vocalsDuration = this.vocals!.getDuration();

    // Re-sync to instrumental's current position (with the new offset applied)
    if (this.instrumental) {
      this._seekVocals(this.instrumental.getCurrentTime());
      if (wasPlaying) this.vocals!.play();
    }
  }

  async loadTakeTrack(filePath: string, container: HTMLElement, startOffset = 0): Promise<void> {
    this.take?.destroy();
    this.take = null;

    const wasPlaying = this._isPlaying;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));

    this.take = WaveSurfer.create({
      height: 80,
      waveColor: "#ff8c1e",
      progressColor: "#ff8c1e",
      cursorColor: "#ff8c1e",
      cursorWidth: 2,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      container,
      url,
    });

    await new Promise<void>((resolve, reject) => {
      const unsubReady = this.take!.on("ready", () => { unsubReady(); unsubError(); resolve(); });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const unsubError = this.take!.on("error", (err: any) => { unsubReady(); unsubError(); reject(new Error(err?.message ?? String(err))); });
    });

    this._takeOffset   = startOffset;
    this._takeDuration = this.take.getDuration();

    // Constrain the container to the correct time window so the waveform
    // lines up visually with the other tracks (vocals, instrumental).
    // Read railWidth BEFORE resizing so the ratio calculation uses the full width.
    // setOptions({ width }) forces WaveSurfer to redraw — more reliable than
    // relying on its ResizeObserver to pick up the CSS change.
    if (this._duration > 0 && this._takeDuration > 0) {
      const railWidth = container.offsetWidth;
      const widthPx   = Math.round((this._takeDuration / this._duration) * railWidth);
      const marginPx  = Math.round((startOffset        / this._duration) * railWidth);
      container.style.marginLeft = `${marginPx}px`;
      container.style.width      = `${widthPx}px`;
      this.take.setOptions({ width: widthPx });
    }

    this.take.on("interaction", (newTime) => {
      const instrTime = newTime + this._takeOffset;
      const instrProgress = Math.max(0, Math.min(1, instrTime / this._duration));
      this.instrumental?.seekTo(instrProgress);
      this._seekVocals(instrTime);
    });

    this._takeIsPlaying = false;
    if (this.instrumental) {
      const instrTime = this.instrumental.getCurrentTime();
      this._seekTake(instrTime);
      if (wasPlaying && instrTime >= this._takeOffset && instrTime < this._takeOffset + this._takeDuration) {
        this.take.play();
        this._takeIsPlaying = true;
      }
    }
  }

  setTakeVolume(volume: number): void {
    this.take?.setVolume(volume);
  }

  clearTakeTrack(): void {
    this.take?.destroy();
    this.take = null;
    this._takeOffset = 0;
    this._takeDuration = 0;
    this._takeIsPlaying = false;
  }

  loadInstrumentalFromPath(filePath: string): void {
    if (!this.instrumental) return;
    const url = convertFileSrc(filePath.replace(/\\/g, "/"));
    this.instrumental.load(url);
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
    // Use the instrumental as the time reference — it always plays the full song.
    return this.instrumental?.getCurrentTime() ?? 0;
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
    this._stopTimeUpdate();
    this.vocals?.destroy();
    this.instrumental?.destroy();
    this.take?.destroy();
    this.vocals = null;
    this.instrumental = null;
    this.take = null;
    this._isPlaying = false;
    this._duration = 0;
    this._vocalsOffset = 0;
    this._vocalsDuration = 0;
    this._takeOffset = 0;
    this._takeDuration = 0;
    this._takeIsPlaying = false;
  }

  private _startTimeUpdate(): void {
    this._stopTimeUpdate();
    const tick = () => {
      if (!this._isPlaying) return;

      const time = this.getCurrentTime();

      // Handle loop — must run every frame for accurate looping
      if (
        this._loopStart !== null &&
        this._loopEnd !== null &&
        time >= this._loopEnd
      ) {
        this.seekTo(this._loopStart);
      }

      // Take window sync: start/stop the take as the playhead enters/exits its time window
      if (this.take && this._takeDuration > 0) {
        const inWindow = time >= this._takeOffset && time < this._takeOffset + this._takeDuration;
        if (inWindow && !this._takeIsPlaying) {
          this.take.play();
          this._takeIsPlaying = true;
        } else if (!inWindow && this._takeIsPlaying) {
          this.take.pause();
          this._takeIsPlaying = false;
        }
      }

      // Throttle store/UI notifications to ~30fps to halve React re-render rate.
      // rAF still runs at 60fps so loop detection stays frame-accurate.
      const now = performance.now();
      if (now - this._lastNotifyTime >= 33) {
        this._lastNotifyTime = now;
        this._timeUpdateCb?.(time);
      }

      this._rafId = requestAnimationFrame(tick);
    };
    this._rafId = requestAnimationFrame(tick);
  }

  private _stopTimeUpdate(): void {
    if (this._rafId !== null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
  }
}
