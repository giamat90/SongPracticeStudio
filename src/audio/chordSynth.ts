import { chordVoicing } from "../lib/chordVoicing";

const ATTACK = 0.03;
const RELEASE = 0.18;
const MASTER_GAIN = 0.2;
const BASS_GAIN = 0.9;
const TONE_GAIN = 0.55;
const OVERTONE_GAIN = 0.3;

/** What the synth needs from the Web Audio API; a test supplies a fake. */
export interface SynthContext {
  currentTime: number;
  state: string;
  destination: unknown;
  resume(): Promise<void>;
  // The Web Audio node types are not worth restating here; the synth only
  // uses gain.value / frequency.value / connect / start / stop / the ramps.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createGain(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  createOscillator(): any;
  setSinkId?: (id: string) => Promise<void>;
}

interface Voice {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gain: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oscillators: any[];
}

export interface ChordSpec {
  chord: string;
  bass?: string | null;
  /** Semitones to move the chord into the key the song sounds in now. */
  semitones?: number;
  /** How far the recording sits from A440, in cents. */
  cents?: number;
}

/**
 * A plain organ-like chord for judging what a chord is: a sustained pad, the
 * root an octave and a half below, a little of the second harmonic so the
 * pitch is clear on small speakers. It is not a backing track.
 */
export class ChordSynth {
  private ctx: SynthContext | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private master: any = null;
  private voices: Voice[] = [];
  private heldKey: string | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  private sinkId = "";

  constructor(private readonly makeContext: (sinkId: string) => SynthContext = defaultContext) {}

  private context(): SynthContext {
    if (!this.ctx) {
      this.ctx = this.makeContext(this.sinkId);
      this.master = this.ctx.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch((e: unknown) => console.warn("[chordSynth] could not resume the audio context:", e));
    }
    return this.ctx;
  }

  private static key(spec: ChordSpec): string {
    return JSON.stringify([spec.chord, spec.bass ?? null, spec.semitones ?? 0, Math.round(spec.cents ?? 0)]);
  }

  private begin(spec: ChordSpec): boolean {
    const voicing = chordVoicing(spec.chord, spec.bass, spec.semitones ?? 0, spec.cents ?? 0);
    if (voicing === null) return false;
    const ctx = this.context();
    const now = ctx.currentTime;
    const notes = [
      { freq: voicing.bass, level: BASS_GAIN },
      ...voicing.upper.map((freq) => ({ freq, level: TONE_GAIN })),
    ];
    const share = 1 / Math.sqrt(notes.length);
    for (const { freq, level } of notes) {
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level * share, now + ATTACK);
      gain.connect(this.master);
      const oscillators = [1, 2].map((multiple) => {
        const osc = ctx.createOscillator();
        osc.frequency.value = freq * multiple;
        const part = ctx.createGain();
        part.gain.value = multiple === 1 ? 1 : OVERTONE_GAIN;
        osc.connect(part);
        part.connect(gain);
        osc.start(now);
        return osc;
      });
      this.voices.push({ gain, oscillators });
    }
    return true;
  }

  /** Sound `spec` for `seconds`, replacing whatever is sounding. Returns false for a chord that is not known. */
  play(spec: ChordSpec, seconds = 1.6): boolean {
    this.stop();
    if (!this.begin(spec)) return false;
    this.stopTimer = setTimeout(() => this.stop(), seconds * 1000);
    return true;
  }

  /** Sound `spec` until `stop()`; asking for the chord that already sounds does nothing. */
  hold(spec: ChordSpec): boolean {
    const key = ChordSynth.key(spec);
    if (this.heldKey === key && this.voices.length > 0) return true;
    this.stop();
    if (!this.begin(spec)) return false;
    this.heldKey = key;
    return true;
  }

  stop(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    this.heldKey = null;
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const voice of this.voices) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + RELEASE);
      for (const osc of voice.oscillators) osc.stop(now + RELEASE + 0.02);
    }
    this.voices = [];
  }

  /** Follow the app's output device, like the stems do. */
  setOutputDevice(deviceId: string): void {
    this.sinkId = deviceId;
    const ctx = this.ctx;
    if (ctx?.setSinkId) {
      ctx.setSinkId(deviceId).catch((e: unknown) => console.warn("[chordSynth] setSinkId failed:", e));
    }
  }
}

function defaultContext(sinkId: string): SynthContext {
  const options = sinkId ? ({ sinkId } as AudioContextOptions) : undefined;
  return new AudioContext(options) as unknown as SynthContext;
}

export const chordSynth = new ChordSynth();
