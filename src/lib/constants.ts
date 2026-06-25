export const NOTE_NAMES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

/** A4 = 440 Hz reference */
export const A4_FREQUENCY = 440;
export const A4_MIDI = 69;

/** Convert MIDI note number to frequency */
export function midiToFrequency(midi: number): number {
  return A4_FREQUENCY * Math.pow(2, (midi - A4_MIDI) / 12);
}

/** Convert frequency to MIDI note number (fractional) */
export function frequencyToMidi(freq: number): number {
  return A4_MIDI + 12 * Math.log2(freq / A4_FREQUENCY);
}

/** Convert frequency to note name + cents offset */
export function frequencyToNote(freq: number): { note: string; cents: number } {
  const midi = frequencyToMidi(freq);
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const note = NOTE_NAMES[rounded % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { note: `${note}${octave}`, cents };
}
