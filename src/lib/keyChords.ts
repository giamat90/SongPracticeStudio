import { CHORD_NOTES } from "./chordNames";

/** Semitones above the tonic and quality of the chords that belong to a key, in the order a musician names them. */
const MAJOR: readonly (readonly [number, string])[] = [
  [0, "maj"], [2, "min"], [4, "min"], [5, "maj"], [7, "maj"], [9, "min"], [7, "7"], [11, "dim"],
];
const MINOR: readonly (readonly [number, string])[] = [
  [0, "min"], [2, "dim"], [3, "maj"], [5, "min"], [7, "min"], [8, "maj"], [10, "maj"], [7, "maj"], [7, "7"],
];

/**
 * The chords of a detected key such as "A minor" or "D# major" ("C:maj",
 * "D:min", ...), moved by `semitones`; empty when the key is not understood.
 * Offered next to the detector's own guesses, because a progression that
 * stays in its key is where a wrong chord most likely belongs.
 */
export function keyChords(key: string | undefined | null, semitones = 0): string[] {
  if (!key) return [];
  const [tonic, mode] = key.trim().split(/\s+/);
  const tonicIndex = CHORD_NOTES.indexOf(tonic);
  if (tonicIndex < 0 || (mode !== "major" && mode !== "minor")) return [];
  const out: string[] = [];
  for (const [offset, quality] of mode === "major" ? MAJOR : MINOR) {
    const chord = `${CHORD_NOTES[(((tonicIndex + offset + semitones) % 12) + 12) % 12]}:${quality}`;
    if (!out.includes(chord)) out.push(chord);
  }
  return out;
}
