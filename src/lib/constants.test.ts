import { describe, it, expect } from "vitest";
import {
  NOTE_NAMES,
  frequencyToMidi,
  frequencyToNote,
  midiToFrequency,
} from "./constants";

describe("midi <-> frequency", () => {
  it("anchors A4 = 440 Hz = MIDI 69", () => {
    expect(midiToFrequency(69)).toBe(440);
    expect(frequencyToMidi(440)).toBe(69);
  });

  it("doubles per octave", () => {
    expect(midiToFrequency(81)).toBeCloseTo(880, 9);
    expect(midiToFrequency(57)).toBeCloseTo(220, 9);
  });

  it("matches the reference value for middle C", () => {
    expect(midiToFrequency(60)).toBeCloseTo(261.6256, 3);
  });

  it("round-trips across the piano range", () => {
    for (let m = 21; m <= 108; m++) {
      expect(frequencyToMidi(midiToFrequency(m))).toBeCloseTo(m, 9);
    }
  });
});

describe("frequencyToNote", () => {
  it("names A4 with zero cents", () => expect(frequencyToNote(440)).toEqual({ note: "A4", cents: 0 }));
  it("names middle C as C4", () => expect(frequencyToNote(261.6256).note).toBe("C4"));
  it("rounds cents and reports the sign (sharp positive)", () => {
    const sharp = frequencyToNote(440 * Math.pow(2, 20 / 1200));
    expect(sharp).toEqual({ note: "A4", cents: 20 });
    const flat = frequencyToNote(440 * Math.pow(2, -20 / 1200));
    expect(flat).toEqual({ note: "A4", cents: -20 });
  });
  it("rolls over to the next note beyond 50 cents", () => {
    expect(frequencyToNote(440 * Math.pow(2, 60 / 1200)).note).toBe("A#4");
  });
  it("covers every note name", () => {
    const seen = new Set<string>();
    for (let m = 60; m < 72; m++) seen.add(frequencyToNote(midiToFrequency(m)).note.replace(/\d/g, ""));
    expect([...seen].sort()).toEqual([...NOTE_NAMES].sort());
  });
  it("uses a valid octave for C0 and C7", () => {
    expect(frequencyToNote(midiToFrequency(12)).note).toBe("C0");
    expect(frequencyToNote(midiToFrequency(96)).note).toBe("C7");
  });
  it("does not return 'undefined' for very low frequencies", () => {
    expect(frequencyToNote(4).note).not.toMatch(/undefined/);
  });
  it("names notes below MIDI 0 with a wrapped pitch class and a negative octave", () => {
    expect(frequencyToNote(midiToFrequency(-1)).note).toBe("B-2");
    expect(frequencyToNote(midiToFrequency(-12)).note).toBe("C-2");
    expect(frequencyToNote(midiToFrequency(-13)).note).toBe("B-3");
  });
});
