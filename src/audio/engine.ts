import WaveSurfer from "wavesurfer.js";
import { convertFileSrc } from "@tauri-apps/api/core";

export type TimeUpdateCallback = (currentTime: number) => void;
export type FinishCallback = () => void;

export const STEM_COLORS: Record<string, string> = {
  vocals: "rgba(74,158,255,0.85)",
  drums:  "rgba(180,80,220,0.85)",
  bass:   "rgba(60,200,100,0.85)",
  guitar: "rgba(255,140,30,0.85)",
  piano:  "rgba(255,220,50,0.85)",
  other:  "rgba(160,160,160,0.85)",
};

export class AudioEngine {
  private _stems: Map<string, WaveSurfer> = new Map();
  private _master: WaveSurfer | null = null;
  private _duration = 0;
  private _isPlaying = false;
  private _loopStart: number | null = null;
  private _loopEnd: number | null = null;
  private _timeUpdateCb: TimeUpdateCallback | null = null;
  private _finishCb: FinishCallback | null = null;
  private _rafId: number | null = null;
  private _lastNotifyTime = 0;

  async load(
    songDir: string,
    stemNames: string[],
    containers: Record<string, HTMLElement>,
  ): Promise<void> {
    this.destroy();

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
        cursorColor: "#e94560",
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
      });
      this._stems.set(name, ws);

      return new Promise<void>((resolve, reject) => {
        ws.on("ready", () => resolve());
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ws.on("error", (err: any) =>
          reject(new Error(`${name} failed to load: ${err?.message ?? err}`))
        );
      });
    });

    await Promise.all(promises);
    if (this._stems.size === 0) return;

    // Master clock: prefer vocals, otherwise use first available stem
    const masterName = this._stems.has("vocals") ? "vocals" : stemNames.find((n) => this._stems.has(n))!;
    this._master = this._stems.get(masterName)!;
    this._duration = this._master.getDuration();

    // Sync: clicking any stem waveform seeks all others
    for (const [name, ws] of this._stems) {
      ws.on("interaction", (time) => {
        const progress = Math.max(0, Math.min(1, time / this._duration));
        for (const [otherName, other] of this._stems) {
          if (otherName !== name) other.seekTo(progress);
        }
      });
    }

    this._master.on("finish", () => {
      this._isPlaying = false;
      this._stopTimeUpdate();
      this._finishCb?.();
    });
  }

  play(): void {
    if (this._stems.size === 0) return;
    for (const ws of this._stems.values()) ws.play();
    this._isPlaying = true;
    this._startTimeUpdate();
  }

  pause(): void {
    for (const ws of this._stems.values()) ws.pause();
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
  }

  setStemVolume(name: string, volume: number): void {
    this._stems.get(name)?.setVolume(volume);
  }

  setPlaybackRate(rate: number): void {
    for (const ws of this._stems.values()) ws.setPlaybackRate(rate);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    await Promise.all(
      [...this._stems.values()].map((ws) => ws.setSinkId(deviceId))
    );
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
    this._stopTimeUpdate();
    for (const ws of this._stems.values()) ws.destroy();
    this._stems.clear();
    this._master = null;
    this._isPlaying = false;
    this._duration = 0;
    this._loopStart = null;
    this._loopEnd = null;
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
