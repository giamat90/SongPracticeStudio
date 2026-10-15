import { CHORD_NOTES } from "./chordNames";

/** Semitones above the root, for every quality the editor and the detector write. */
const INTERVALS: Record<string, readonly number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  "6": [0, 4, 7, 9],
};

export interface ChordVoicing {
  /** Frequency of the bass note (Hz). */
  bass: number;
  /** Frequencies of the chord tones above it, lowest first (Hz). */
  upper: number[];
}

const mod12 = (n: number) => ((n % 12) + 12) % 12;

function frequency(midi: number, cents: number): number {
  return 440 * 2 ** ((midi - 69) / 12 + cents / 1200);
}

/**
 * The notes to play for `chord` ("C:maj") and its slash `bass` ("E"): the chord
 * in close position around middle C and the bass an octave and a half below,
 * so the quality is easy to judge and the register is the same for every root.
 *
 * `semitones` moves it into the key the song now sounds in (the transpose; the
 * capo changes the shapes shown, never the sound), and `cents` is how far the
 * recording sits from A440, so the chord is in tune with the song and not with
 * a piano. Returns null for a chord this does not know.
 */
export function chordVoicing(
  chord: string,
  bass: string | null | undefined,
  semitones = 0,
  cents = 0,
): ChordVoicing | null {
  const [root, quality] = chord.split(":");
  const rootIndex = CHORD_NOTES.indexOf(root);
  const intervals = quality === undefined ? undefined : INTERVALS[quality];
  if (rootIndex < 0 || intervals === undefined) return null;

  const rootPc = mod12(rootIndex + semitones);
  const rootMidi = 60 + mod12(rootPc + 5) - 5;
  const bassIndex = bass ? CHORD_NOTES.indexOf(bass) : -1;
  const bassPc = bassIndex >= 0 ? mod12(bassIndex + semitones) : rootPc;
  return {
    bass: frequency(36 + bassPc, cents),
    upper: intervals.map((i) => frequency(rootMidi + i, cents)),
  };
}
