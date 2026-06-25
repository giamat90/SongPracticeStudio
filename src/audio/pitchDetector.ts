import { frequencyToNoteName } from "./analysisUtils";

export interface PitchReading {
  frequency: number;
  name: string;
  cents: number;
}

/**
 * Real-time pitch detector using Web Audio autocorrelation.
 * Attach to a MediaStream (mic) and call getCurrentPitch() on each animation frame.
 */
export class PitchDetector {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private buffer: Float32Array<ArrayBuffer> = new Float32Array(0) as Float32Array<ArrayBuffer>;

  start(stream: MediaStream): void {
    this.stop();
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.buffer = new Float32Array(this.analyser.fftSize) as Float32Array<ArrayBuffer>;
    this.source = this.ctx.createMediaStreamSource(stream);
    this.source.connect(this.analyser);
  }

  getCurrentPitch(): PitchReading | null {
    if (!this.analyser) return null;
    this.analyser.getFloatTimeDomainData(this.buffer);

    const freq = this._autocorrelate(this.buffer, this.ctx!.sampleRate);
    if (freq <= 0) return null;

    const { name, cents } = frequencyToNoteName(freq);
    return { frequency: freq, name, cents };
  }

  stop(): void {
    this.source?.disconnect();
    this.ctx?.close();
    this.ctx = null;
    this.analyser = null;
    this.source = null;
  }

  private _autocorrelate(buf: Float32Array<ArrayBuffer>, sampleRate: number): number {
    const SIZE = buf.length;

    // Check RMS — if too quiet, no pitch
    let rms = 0;
    for (let i = 0; i < SIZE; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / SIZE);
    if (rms < 0.01) return -1;

    // Trim silent edges
    let r1 = 0, r2 = SIZE - 1;
    for (let i = 0; i < SIZE / 2; i++) {
      if (Math.abs(buf[i]) < 0.2) { r1 = i; break; }
    }
    for (let i = 1; i < SIZE / 2; i++) {
      if (Math.abs(buf[SIZE - i]) < 0.2) { r2 = SIZE - i; break; }
    }
    const trimmed = buf.slice(r1, r2);
    const len = trimmed.length;

    // Autocorrelation
    const c = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      for (let j = 0; j < len - i; j++) {
        c[i] += trimmed[j] * trimmed[j + i];
      }
    }

    // Find first zero crossing then first peak
    let d = 0;
    while (c[d] > c[d + 1]) d++;
    let maxVal = -1, maxPos = -1;
    for (let i = d; i < len; i++) {
      if (c[i] > maxVal) { maxVal = c[i]; maxPos = i; }
    }

    // Parabolic interpolation for sub-sample accuracy
    const x1 = c[maxPos - 1] ?? 0;
    const x2 = c[maxPos];
    const x3 = c[maxPos + 1] ?? 0;
    const a = (x1 + x3 - 2 * x2) / 2;
    const b = (x3 - x1) / 2;
    const shift = a !== 0 ? -b / (2 * a) : 0;

    return sampleRate / (maxPos + shift);
  }
}
