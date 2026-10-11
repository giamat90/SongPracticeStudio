export interface BassNote {
  time: number;
  duration: number;
  pitch: number;
  /** 0 = E, 1 = A, 2 = D, 3 = G */
  string: number;
  fret: number;
}

export interface BassTabData {
  version: number;
  duration: number;
  notes: BassNote[];
}

export const BASS_STRING_NAMES = ["E", "A", "D", "G"] as const;

const TICKS_PER_BEAT = 480;
const DEFAULT_BPM = 120;
const VELOCITY = 96;
const FINGERED_BASS = 33;

function vlq(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  const out = [v & 0x7f];
  while ((v >>= 7) > 0) out.unshift((v & 0x7f) | 0x80);
  return out;
}

/** The notes that sound at some point between `from` and `to` (seconds), in time order. */
export function visibleNotes(notes: BassNote[], from: number, to: number): BassNote[] {
  return notes.filter((n) => n.time < to && n.time + n.duration > from);
}

/** A format 0 Standard MIDI File of the transcription, at a fixed tempo, as a fingered electric bass. */
export function bassTabToMidi(notes: BassNote[], bpm: number): Uint8Array {
  const tempoBpm = bpm > 0 ? bpm : DEFAULT_BPM;
  const ticksPerSecond = (tempoBpm / 60) * TICKS_PER_BEAT;
  const microsPerBeat = Math.round(60_000_000 / tempoBpm);

  interface Ev { tick: number; order: number; bytes: number[] }
  const events: Ev[] = [];
  for (const n of notes) {
    if (!(n.duration > 0)) continue;
    const pitch = Math.max(0, Math.min(127, Math.round(n.pitch)));
    const on = Math.round(n.time * ticksPerSecond);
    const off = Math.max(on + 1, Math.round((n.time + n.duration) * ticksPerSecond));
    events.push({ tick: on, order: 1, bytes: [0x90, pitch, VELOCITY] });
    events.push({ tick: off, order: 0, bytes: [0x80, pitch, 0] });
  }
  events.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const track: number[] = [
    0x00, 0xff, 0x51, 0x03, (microsPerBeat >> 16) & 0xff, (microsPerBeat >> 8) & 0xff, microsPerBeat & 0xff,
    0x00, 0xc0, FINGERED_BASS,
  ];
  let last = 0;
  for (const e of events) {
    track.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  track.push(0x00, 0xff, 0x2f, 0x00);

  const u32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0x00, 0x00, 0x00, 0x01, (TICKS_PER_BEAT >> 8) & 0xff, TICKS_PER_BEAT & 0xff,
    0x4d, 0x54, 0x72, 0x6b, ...u32(track.length), ...track,
  ]);
}

export const TAB_WINDOW_SECONDS = 6;
const TAB_PLAYHEAD_FRACTION = 0.25;

/** Song time at the left edge of the tab when the playhead is at `currentTime`. */
export function tabWindowStart(currentTime: number): number {
  return currentTime - TAB_WINDOW_SECONDS * TAB_PLAYHEAD_FRACTION;
}

export function tabTimeToX(time: number, windowStart: number, width: number): number {
  return ((time - windowStart) / TAB_WINDOW_SECONDS) * width;
}

export function tabXToTime(x: number, windowStart: number, width: number): number {
  return windowStart + (x / width) * TAB_WINDOW_SECONDS;
}
