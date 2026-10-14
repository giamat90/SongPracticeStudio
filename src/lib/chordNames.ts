const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function shiftNote(note: string, semitones: number): string | null {
  const i = NOTE_NAMES.indexOf(note);
  if (i < 0) return null;
  return NOTE_NAMES[(((i + semitones) % 12) + 12) % 12];
}

/** "E" shifted up by 2 semitones -> "F#"; anything that is not a note is returned as is. */
export function transposeNote(note: string, semitones: number): string {
  return shiftNote(note, semitones) ?? note;
}

/** "C:maj" shifted up by 2 semitones -> "D:maj"; anything that is not a note:quality pair is returned as is. */
export function transposeChord(chord: string, semitones: number): string {
  const [root, quality] = chord.split(":");
  const shifted = shiftNote(root, semitones);
  if (shifted === null || quality === undefined) return chord;
  return `${shifted}:${quality}`;
}

/** "A minor" shifted down by 3 -> "F# minor". */
export function transposeKey(key: string, semitones: number): string {
  const [root, ...rest] = key.split(" ");
  const shifted = shiftNote(root, semitones);
  return shifted === null ? key : [shifted, ...rest].join(" ");
}

/** The chord qualities the editor offers, in the order it lists them. The detector writes the first five. */
export const CHORD_QUALITIES: { value: string; label: string; suffix: string }[] = [
  { value: "maj", label: "major", suffix: "" },
  { value: "min", label: "minor", suffix: "m" },
  { value: "7", label: "dominant 7", suffix: "7" },
  { value: "maj7", label: "major 7", suffix: "maj7" },
  { value: "min7", label: "minor 7", suffix: "m7" },
  { value: "sus2", label: "sus2", suffix: "sus2" },
  { value: "sus4", label: "sus4", suffix: "sus4" },
  { value: "dim", label: "diminished", suffix: "dim" },
  { value: "aug", label: "augmented", suffix: "aug" },
  { value: "6", label: "sixth", suffix: "6" },
];

/** The twelve root / bass note names, sharp-spelled like the detector writes them. */
export const CHORD_NOTES: readonly string[] = NOTE_NAMES;

const QUALITY_SUFFIX: Record<string, string> = Object.fromEntries(
  CHORD_QUALITIES.map((q) => [q.value, q.suffix]),
);

/**
 * How much of a chord is shown: easy is the triad (C, Am), medium keeps the
 * sevenths, advanced adds the slash-chord bass note.
 */
export type ChordDetail = "easy" | "medium" | "advanced";

export const CHORD_DETAILS: { value: ChordDetail; label: string; hint: string }[] = [
  { value: "easy", label: "Easy", hint: "Major and minor chords only: C, Am, G" },
  { value: "medium", label: "Medium", hint: "Adds seventh chords: C, Am7, G7, Fmaj7" },
  { value: "advanced", label: "Advanced", hint: "Everything detected, with slash-chord bass notes: C/E" },
];

export function isChordDetail(value: unknown): value is ChordDetail {
  return CHORD_DETAILS.some((d) => d.value === value);
}

const TRIAD_OF: Record<string, string> = { "7": "maj", maj7: "maj", "6": "maj", min7: "min" };

/** The chord and bass note as shown at `detail`; the chord's root and its triad are never changed. */
export function simplifyChord(
  chord: string,
  bass: string | null | undefined,
  detail: ChordDetail,
): { chord: string; bass: string | null } {
  if (detail === "advanced") return { chord, bass: bass ?? null };
  if (detail === "medium") return { chord, bass: null };
  const [root, quality] = chord.split(":");
  const triad = quality === undefined ? undefined : TRIAD_OF[quality];
  return { chord: triad === undefined ? chord : `${root}:${triad}`, bass: null };
}

/** "C:maj" -> "C", "A:min7" -> "Am7", with a slash bass note when given: "C:maj", "E" -> "C/E" */
export function formatChordName(chord: string, bass?: string | null): string {
  const [root, quality] = chord.split(":");
  const name = `${root}${QUALITY_SUFFIX[quality] ?? ""}`;
  return bass ? `${name}/${bass}` : name;
}
