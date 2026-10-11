const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function shiftNote(note: string, semitones: number): string | null {
  const i = NOTE_NAMES.indexOf(note);
  if (i < 0) return null;
  return NOTE_NAMES[(((i + semitones) % 12) + 12) % 12];
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

/** Chord name like "C:maj" / "A:min" -> "C" / "Am" */
export function formatChordName(chord: string): string {
  const [root, quality] = chord.split(":");
  return quality === "min" ? `${root}m` : root;
}
