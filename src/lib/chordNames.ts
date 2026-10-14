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

/** "C:maj" -> "C", "A:min7" -> "Am7", with a slash bass note when given: "C:maj", "E" -> "C/E" */
export function formatChordName(chord: string, bass?: string | null): string {
  const [root, quality] = chord.split(":");
  const name = `${root}${QUALITY_SUFFIX[quality] ?? ""}`;
  return bass ? `${name}/${bass}` : name;
}
