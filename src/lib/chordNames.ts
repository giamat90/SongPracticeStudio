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

const QUALITY_SUFFIX: Record<string, string> = {
  maj: "",
  min: "m",
  "7": "7",
  maj7: "maj7",
  min7: "m7",
};

/** "C:maj" -> "C", "A:min7" -> "Am7", with a slash bass note when given: "C:maj", "E" -> "C/E" */
export function formatChordName(chord: string, bass?: string | null): string {
  const [root, quality] = chord.split(":");
  const name = `${root}${QUALITY_SUFFIX[quality] ?? ""}`;
  return bass ? `${name}/${bass}` : name;
}
