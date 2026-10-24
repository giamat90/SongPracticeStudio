import { describe, expect, it } from "vitest";
import { buildTabScore, loadAlphaTab, readScore } from "./tabScore";
import {
  exportTab, firstNoteOfBar, linkedNotes, movability, moveToString, neighbourNote, playerString, restore, stepString, type TabNoteModel,
} from "./tabEdit";

// Standard guitar tuning. alphaTex writes `fret.string` with string 1 the thinnest; the model counts from the lowest.
const TEX = String.raw`\tempo 120
\track "Guitar"
\instrument 29
\ts 4 4
5.3.4 -.3.4 7.3{h}.4 9.3.4 | 5.3{sl}.4 7.3.4 12.3{nh}.4 3.2{ah}.4 | (3.3 3.2).4 0.6.4 0.1.4 0.4.4 | 3.2.4 15.1.4 3.6.4 22.1.4`;

async function load() {
  const at = await loadAlphaTab();
  const score = at.importer.ScoreLoader.loadAlphaTex(TEX, new at.Settings());
  const notes: TabNoteModel[] = [];
  for (const bar of score.tracks[0].staves[0].bars) {
    for (const beat of bar.voices[0].beats) notes.push(...beat.notes);
  }
  return { at, score, notes };
}

describe("movability", () => {
  it("offers every other string that plays the note at the same pitch", async () => {
    const { notes } = await load();
    const note = notes[9]; // bar 3, string 4 (D) fret 3 -> F, in the chord with the G string note
    const result = movability(note);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const pitches = new Set<number>();
    for (const choice of result.choices) {
      const copy = note.fret;
      const string = note.string;
      moveToString(note, choice.string);
      pitches.add(note.realValue);
      note.string = string;
      note.fret = copy;
    }
    expect([...pitches]).toEqual([note.realValue]);
    expect(result.choices.map((c) => c.string)).not.toContain(note.string);
  });

  it("keeps the fret between the nut and the 24th", async () => {
    const { notes } = await load();
    const high = notes.find((n) => n.fret === 15 && n.string === 6) as TabNoteModel; // G5 on the thinnest string
    const result = movability(high);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.choices).toEqual([{ string: 5, fret: 20 }, { string: 4, fret: 24 }]);
  });

  it("offers nothing when every other string would need a fret past the 24th", async () => {
    const { notes } = await load();
    const top = notes.find((n) => n.fret === 22 && n.string === 6) as TabNoteModel; // E5: the B string would need fret 27
    expect(movability(top)).toEqual({ ok: false, reason: "No other string plays this note." });
  });

  it("leaves out a string another note of the beat already uses", async () => {
    const { notes } = await load();
    const g = notes.find((n) => n.beat.notes.length === 2 && n.string === 4) as TabNoteModel;
    const other = g.beat.notes.find((n) => n !== g) as TabNoteModel;
    const result = movability(g);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.choices.map((c) => c.string)).not.toContain(other.string);
  });

  it("refuses harmonics, which sound by fret and not by pitch", async () => {
    const { notes } = await load();
    const harmonic = notes.filter((n) => n.isHarmonic);
    expect(harmonic.length).toBe(2);
    for (const n of harmonic) {
      const result = movability(n);
      expect(result.ok).toBe(false);
    }
  });

  it("gives a reason, not an empty list, when no string fits", async () => {
    const { notes } = await load();
    const lowest = notes.find((n) => n.string === 1 && n.fret === 0) as TabNoteModel; // open low E: nothing else is that low
    const result = movability(lowest);
    expect(result).toEqual({ ok: false, reason: "No other string plays this note." });
  });
});

describe("moveToString", () => {
  it("moves the note and keeps what it sounds like", async () => {
    const { notes } = await load();
    const note = notes[0]; // fret 5 on the G string (model string 4)
    const pitch = note.realValue;
    const result = movability(note);
    if (!result.ok) throw new Error(result.reason);
    const target = result.choices[0];
    moveToString(note, target.string);
    expect(note.string).toBe(target.string);
    expect(note.fret).toBe(target.fret);
    expect(note.realValue).toBe(pitch);
  });

  it("moves a tie with its origin, so both ends stay on one string", async () => {
    const { notes } = await load();
    const origin = notes[0];
    const destination = notes[1];
    expect(origin.isTieOrigin).toBe(true);
    expect(linkedNotes(destination)).toContain(origin);
    const pitch = origin.realValue;
    const result = movability(destination);
    if (!result.ok) throw new Error(result.reason);
    moveToString(destination, result.choices[0].string);
    expect(origin.string).toBe(destination.string);
    expect(origin.fret).toBe(destination.fret);
    expect(origin.realValue).toBe(pitch);
    expect(destination.realValue).toBe(pitch);
  });

  it("moves a hammer-on and its target together with their own frets", async () => {
    const { notes } = await load();
    const from = notes.find((n) => n.isHammerPullOrigin) as TabNoteModel;
    const to = from.hammerPullDestination as TabNoteModel;
    const pitches = [from.realValue, to.realValue];
    const result = movability(from);
    if (!result.ok) throw new Error(result.reason);
    moveToString(from, result.choices[0].string);
    expect(to.string).toBe(from.string);
    expect([from.realValue, to.realValue]).toEqual(pitches);
    expect(to.fret - from.fret).toBe(2);
  });

  it("moves a slide with its target", async () => {
    const { notes } = await load();
    const from = notes.find((n) => n.slideTarget) as TabNoteModel;
    const to = from.slideTarget as TabNoteModel;
    const result = movability(from);
    if (!result.ok) throw new Error(result.reason);
    moveToString(from, result.choices[0].string);
    expect(to.string).toBe(from.string);
  });

  it("refuses a string the note cannot be played on", async () => {
    const { notes } = await load();
    const note = notes[0];
    expect(() => moveToString(note, note.string)).toThrow();
    expect(() => moveToString(notes.find((n) => n.isHarmonic) as TabNoteModel, 1)).toThrow();
  });

  it("is undone, and redone, by restore", async () => {
    const { notes } = await load();
    const note = notes[0];
    const before = { string: note.string, fret: note.fret };
    const result = movability(note);
    if (!result.ok) throw new Error(result.reason);
    const undo = moveToString(note, result.choices[0].string);
    const moved = { string: note.string, fret: note.fret };
    const redo = restore(undo);
    expect({ string: note.string, fret: note.fret }).toEqual(before);
    restore(redo);
    expect({ string: note.string, fret: note.fret }).toEqual(moved);
  });
});

describe("stepString", () => {
  it("goes to the string above or below, as the tab is drawn, keeping the pitch", async () => {
    const { notes } = await load();
    const note = notes[0]; // fret 5 on the G string: G string is the 3rd from the thinnest
    const pitch = note.realValue;
    expect(stepString(note, "up")).toEqual({ string: 5, fret: 1 });
    expect(stepString(note, "down")).toEqual({ string: 3, fret: 10 });
    const to = stepString(note, "up") as { string: number; fret: number };
    moveToString(note, to.string);
    expect(note.realValue).toBe(pitch);
    expect(playerString(note, note.string)).toBe(2);
  });

  it("has nothing past the thinnest string, and skips a string that cannot play the note", async () => {
    const { notes } = await load();
    const top = notes.find((n) => n.fret === 3 && n.string === 5 && n.beat.voice.bar.index === 3) as TabNoteModel; // F on the B string: the high E would need fret -2
    expect(stepString(top, "up")).toBeNull();
    expect(stepString(top, "down")).toEqual({ string: 4, fret: 7 });
    const high = notes.find((n) => n.fret === 15 && n.string === 6) as TabNoteModel;
    expect(stepString(high, "down")).toEqual({ string: 5, fret: 20 });
  });

  it("is null for a note that cannot move", async () => {
    const { notes } = await load();
    expect(stepString(notes.find((n) => n.isHarmonic) as TabNoteModel, "up")).toBeNull();
  });
});

describe("neighbourNote", () => {
  it("walks forward and back through the track, across bars", async () => {
    const { notes } = await load();
    expect(neighbourNote(notes[0], "next")).toBe(notes[1]);
    expect(neighbourNote(notes[1], "previous")).toBe(notes[0]);
    expect(neighbourNote(notes[3], "next")).toBe(notes[4]);
    expect(neighbourNote(notes[4], "previous")).toBe(notes[3]);
  });

  it("stays on the same string when the next beat has a chord", async () => {
    const { notes } = await load();
    const before = notes.find((n) => n.fret === 3 && n.string === 5 && n.beat.notes.length === 1 && n.beat.voice.bar.index === 1) as TabNoteModel;
    expect(before.beat.nextBeat?.notes.length).toBe(2);
    expect(neighbourNote(before, "next")?.string).toBe(5);
  });

  it("ends at the first and the last note", async () => {
    const { notes } = await load();
    expect(neighbourNote(notes[0], "previous")).toBeNull();
    expect(neighbourNote(notes[notes.length - 1], "next")).toBeNull();
  });
});

describe("firstNoteOfBar", () => {
  const bars = async () => {
    const { score, notes } = await load();
    return { bars: score.tracks[0].staves[0].bars, notes };
  };

  it("is the first note played in the bar", async () => {
    const { bars: all, notes } = await bars();
    expect(firstNoteOfBar(all[0])).toBe(notes[0]);
    expect(firstNoteOfBar(all[1])).toBe(notes[4]);
  });

  it("takes the note of a chord nearest to the string the user was on", async () => {
    const { bars: all, notes } = await bars();
    const chord = all[2].voices[0].beats[0].notes;
    expect(chord.length).toBe(2);
    const thin = notes.find((n) => n.string === 6) as TabNoteModel;
    const thick = notes.find((n) => n.string === 1) as TabNoteModel;
    expect(firstNoteOfBar(all[2], thin)?.string).toBe(Math.max(...chord.map((n) => n.string)));
    expect(firstNoteOfBar(all[2], thick)?.string).toBe(Math.min(...chord.map((n) => n.string)));
  });
});

describe("playerString", () => {
  it("counts from the thinnest string, the way a player does", async () => {
    const { notes } = await load();
    const lowE = notes.find((n) => n.string === 1) as TabNoteModel;
    const highE = notes.find((n) => n.string === 6) as TabNoteModel;
    expect(playerString(lowE, lowE.string)).toBe(6);
    expect(playerString(highE, highE.string)).toBe(1);
  });
});

describe("exportTab", () => {
  it("saves a moved note as a .gp file that reads back the same and plays the same", async () => {
    const { at, score, notes } = await load();
    const note = notes[9];
    const before = buildTabScore(at, score);
    const result = movability(note);
    if (!result.ok) throw new Error(result.reason);
    const target = result.choices[0];
    moveToString(note, target.string);

    const bytes = exportTab(at, score);
    const back = readScore(at, bytes);
    const again: TabNoteModel[] = [];
    for (const bar of back.tracks[0].staves[0].bars) {
      for (const beat of bar.voices[0].beats) again.push(...beat.notes);
    }
    const moved = again[9];
    expect([moved.string, moved.fret]).toEqual([target.string, target.fret]);
    expect(buildTabScore(at, back)).toEqual(before);
  });
});
