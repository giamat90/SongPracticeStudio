import { describe, expect, it } from "vitest";
import { loadAlphaTab } from "./tabScore";
import type { TabNoteModel } from "./tabEdit";
import { moveToString } from "./tabEdit";
import {
  applyTranspose, canEditTransposed, clearTranspose, exportUntransposed, allStrings, previewTransposition, retuneTab, storedTuning, transposeEdits, transposeTab,
} from "./tabTranspose";
import { restoreStep } from "./tabEdit";

// 4-string bass, G D A E. alphaTex writes `fret.string` with string 1 the thinnest (G); the model counts from the
// lowest, so the A string is model string 2 and the low E is 1.
const BASS = String.raw`\tempo 120
\track "Bass"
\instrument 33
\tuning (g2 d2 a1 e1)
\ts (4 4)
5.3.4 0.4.4 12.1.4 3.2.4 | (0.4 2.3).4 5.3.4 -.3.4 0.4.4`;

async function load(tex = BASS) {
  const at = await loadAlphaTab();
  const score = at.importer.ScoreLoader.loadAlphaTex(tex, new at.Settings());
  const notes: TabNoteModel[] = [];
  for (const bar of score.tracks[0].staves[0].bars) {
    for (const beat of bar.voices[0].beats) notes.push(...beat.notes);
  }
  return { at, score, notes };
}

const where = (n: TabNoteModel) => ({ string: n.string, fret: n.fret });

describe("applyTranspose", () => {
  it("moves the fret on the same string: down a whole step, 5 becomes 3", async () => {
    const { at, score, notes } = await load();
    const before = notes[0].realValue;
    const result = applyTranspose(at, score, -2);
    expect(notes[0].fret).toBe(3);
    expect(notes[0].string).toBe(2); // the A string (alphaTex string 3 of 4)
    expect(notes[0].realValue).toBe(before - 2);
    expect(result.unplayable).toBeGreaterThan(0);
  });

  it("changes the string when the fret would pass the nut", async () => {
    const { at, score, notes } = await load();
    const f = notes[3]; // F3 on the D string, fret 3
    expect(where(f)).toEqual({ string: 3, fret: 3 });
    const pitch = f.realValue;
    applyTranspose(at, score, -4);
    expect(f.realValue).toBe(pitch - 4);
    expect(where(f)).toEqual({ string: 2, fret: 4 }); // Db3 is the A string, fret 4
  });

  it("flags a note below the lowest open string and leaves it where it was", async () => {
    const { at, score, notes } = await load();
    const low = notes[1]; // open E, the lowest string
    const result = applyTranspose(at, score, -2);
    expect(where(low)).toEqual({ string: 1, fret: 0 });
    expect(low.style?.colors.size).toBeGreaterThan(0);
    expect(result.unplayable).toBeGreaterThanOrEqual(1);
  });

  it("moves notes tied together as one", async () => {
    const { at, score, notes } = await load();
    const tied = notes.filter((n) => n.isTieOrigin || n.isTieDestination);
    expect(tied.length).toBe(2);
    applyTranspose(at, score, 2);
    expect(tied[0].string).toBe(tied[1].string);
    expect(tied[0].fret).toBe(tied[1].fret);
  });

  it("goes up by raising the fret", async () => {
    const { at, score, notes } = await load();
    const before = notes[0].realValue;
    applyTranspose(at, score, 2);
    expect(notes[0].fret).toBe(7);
    expect(notes[0].realValue).toBe(before + 2);
  });

  it("is a no-op for zero and clearTranspose puts every note back", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    expect(applyTranspose(at, score, 0)).toMatchObject({ sameString: 0, newString: 0, unplayable: 0, edited: 0, stale: 0 });
    applyTranspose(at, score, -5);
    expect(notes.map(where)).not.toEqual(original);
    clearTranspose(score);
    expect(notes.map(where)).toEqual(original);
    expect(notes.every((n) => !n.style)).toBe(true);
  });

  it("does not stack: a second transposition starts from the original", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, 2);
    applyTranspose(at, score, 3);
    expect(notes[0].fret).toBe(8);
  });

  it("saves the untransposed score and leaves the transposition drawn", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    applyTranspose(at, score, -2);
    const drawn = notes.map(where);
    const bytes = exportUntransposed(at, score);
    expect(notes.map(where)).toEqual(drawn);
    const back = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
    const saved: TabNoteModel[] = [];
    for (const bar of back.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) saved.push(...beat.notes);
    expect(saved.map(where)).toEqual(original);
  });

  it("leaves percussion and non-fretted tracks alone", async () => {
    const { at, score } = await load(String.raw`\tempo 120
\track "Piano"
\instrument 0
\staff {score}
c4.4 d4.4 e4.4 f4.4`);
    expect(applyTranspose(at, score, -2)).toMatchObject({ sameString: 0, newString: 0, unplayable: 0, edited: 0, stale: 0 });
  });
});

describe("string choices on a transposed score", () => {
  it("reports nothing until a note is moved, then the string it was moved to", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, -4);
    expect(transposeEdits(score)).toEqual([]);
    const f = notes[3];
    moveToString(f, 1);
    expect(transposeEdits(score)).toEqual([
      { track: 0, staff: 0, bar: 0, voice: 0, beat: 3, pitch: 41, string: 1 },
    ]);
  });

  it("puts a saved choice back after the score is drawn again", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, -4);
    moveToString(notes[3], 1);
    const saved = transposeEdits(score);
    const drawn = where(notes[3]);

    const result = applyTranspose(at, score, -4, { edits: saved });
    expect(where(notes[3])).toEqual(drawn);
    expect(result.edited).toBe(1);
    expect(result.stale).toBe(0);
    expect(where(notes[3])).toEqual({ string: 1, fret: 9 });
  });

  it("keeps the choice out of the stored tab and out of other transpositions", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    applyTranspose(at, score, -4);
    moveToString(notes[3], 1);
    const saved = transposeEdits(score);

    applyTranspose(at, score, -2);
    expect(notes[3].string).not.toBe(1);

    applyTranspose(at, score, -4, { edits: saved });
    const back = at.importer.ScoreLoader.loadScoreFromBytes(exportUntransposed(at, score), new at.Settings());
    const stored: TabNoteModel[] = [];
    for (const bar of back.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) stored.push(...beat.notes);
    expect(stored.map(where)).toEqual(original);
    expect(where(notes[3])).toEqual({ string: 1, fret: 9 });
  });

  it("counts a choice for a note that is gone as stale and leaves the score as drawn", async () => {
    const { at, score, notes } = await load();
    const result = applyTranspose(at, score, -4, { edits: [
      { track: 0, staff: 0, bar: 0, voice: 0, beat: 3, pitch: 99, string: 1 },
      { track: 0, staff: 0, bar: 7, voice: 0, beat: 0, pitch: 41, string: 1 },
    ] });
    expect(result.stale).toBe(2);
    expect(result.edited).toBe(0);
    expect(where(notes[3])).toEqual({ string: 2, fret: 4 });
  });

  it("cannot edit a note no string can play", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, -2);
    expect(canEditTransposed(score, notes[1])).toBe(false);
    expect(canEditTransposed(score, notes[0])).toBe(true);
  });
});

const lowestOpen = (n: TabNoteModel) => n.beat.voice.bar.staff.tuning[n.beat.voice.bar.staff.tuning.length - 1];
const everything = { semitones: -2, tracks: "all" as const, keepStrings: true, tuning: "auto" as const };

async function stored(at: Awaited<ReturnType<typeof load>>["at"], bytes: Uint8Array) {
  const back = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
  const out: TabNoteModel[] = [];
  for (const bar of back.tracks[0].staves[0].bars) for (const beat of bar.voices[0].beats) out.push(...beat.notes);
  return out;
}

describe("tuning the lowest string down for a transposition", () => {
  it("suggests the smallest drop that plays the notes below the lowest string", async () => {
    const { at, score } = await load();
    const result = applyTranspose(at, score, -2);
    expect(result.unplayable).toBe(3);
    expect(result.unplayableByTrack).toEqual({ 0: 3 });
    expect(result.suggestions[0][0]).toMatchObject({ offsets: [2, 0, 0, 0], fixes: 3, label: "Lowest string down 2" });
    expect(result.retuned).toEqual({});
  });

  it("plays the open low strings on a string tuned down, and clearTranspose restores the tuning", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const result = applyTranspose(at, score, -2, { retune: { 0: [2] } });
    expect(result.unplayable).toBe(0);
    expect(result.retuned[0]).toMatchObject({ offsets: [2, 0, 0, 0] });
    expect(result.suggestions).toEqual({});
    expect(where(notes[1])).toEqual({ string: 1, fret: 0 });
    expect(notes[1].realValue).toBe(26);
    expect(lowestOpen(notes[1])).toBe(26);
    expect(notes[1].style).toBeFalsy();
    clearTranspose(score);
    expect(lowestOpen(notes[1])).toBe(28);
    expect(notes.map(where)).toEqual(original);
  });

  it("keeps the tuning out of the stored tab when the transposed score is saved", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, -2, { retune: { 0: [2] } });
    const back = await stored(at, exportUntransposed(at, score));
    expect(lowestOpen(back[1])).toBe(28);
    expect(lowestOpen(notes[1])).toBe(26);
  });

  it("puts the lowest fret first when notes need not stay on their strings", async () => {
    const { at, score, notes } = await load();
    applyTranspose(at, score, 2, { keepStrings: false });
    expect(where(notes[0])).toEqual({ string: 3, fret: 2 });
  });
});

describe("transposeTab", () => {
  it("rewrites the stored tab, tunes the low string down, and one undo puts everything back", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const { step, result } = transposeTab(at, score, everything);
    expect(result.unplayable).toBe(0);
    expect(result.retuned[0]).toMatchObject({ offsets: [2, 0, 0, 0] });
    expect(notes[0].fret).toBe(3);
    expect(lowestOpen(notes[1])).toBe(26);

    const back = await stored(at, exportUntransposed(at, score));
    expect(lowestOpen(back[1])).toBe(26);
    expect(back.map((n) => n.realValue)).toEqual(notes.map((n) => n.realValue));

    restoreStep(step);
    expect(lowestOpen(notes[1])).toBe(28);
    expect(notes.map(where)).toEqual(original);
  });

  it("leaves a note nothing can play where it is, when no retune is asked for", async () => {
    const { at, score, notes } = await load();
    const { result } = transposeTab(at, score, { ...everything, tuning: "keep" as const });
    expect(result.unplayable).toBe(3);
    expect(where(notes[1])).toEqual({ string: 1, fret: 0 });
    expect(lowestOpen(notes[1])).toBe(28);
    expect(notes[1].style).toBeFalsy();
  });

  it("changes only the chosen track", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const { result } = transposeTab(at, score, { ...everything, tracks: 5 });
    expect(result.sameString + result.newString + result.unplayable).toBe(0);
    expect(notes.map(where)).toEqual(original);
  });

  it("refuses while the score shows the song's transposition", async () => {
    const { at, score } = await load();
    applyTranspose(at, score, 2);
    expect(() => transposeTab(at, score, everything)).toThrow(/Reset the song's transpose/);
  });

  it("previews without keeping anything", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const preview = previewTransposition(at, score, everything);
    expect(preview.retuned[0]).toMatchObject({ offsets: [2, 0, 0, 0] });
    expect(notes.map(where)).toEqual(original);
    expect(lowestOpen(notes[1])).toBe(28);
  });
});

describe("tuning a whole instrument", () => {
  it("suggests the lowest string and the whole instrument, best first", async () => {
    const { at, score } = await load();
    const found = applyTranspose(at, score, -2).suggestions[0];
    expect(found.map((s) => s.label)).toEqual(["Lowest string down 2", "All strings down 2"]);
    expect(found.map((s) => s.fixes)).toEqual([3, 3]);
  });

  it("keeps every fret when the whole instrument goes down with the song", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const result = applyTranspose(at, score, -2, { retune: { 0: allStrings(2) } });
    expect(result.unplayable).toBe(0);
    expect(result.retuned[0].label).toBe("All strings down 2");
    expect(notes.map(where)).toEqual(original);
    expect(notes[0].realValue).toBe(36);
  });

  it("remembers the tab's own tuning while the live score is retuned", async () => {
    const { at, score } = await load();
    expect(storedTuning(score, 0)).toEqual([28, 33, 38, 43]);
    applyTranspose(at, score, -2, { retune: { 0: allStrings(2) } });
    expect(storedTuning(score, 0)).toEqual([28, 33, 38, 43]);
    expect(storedTuning(score, 9)).toBeNull();
  });

  it("transposes the tab with every string down by the same amount", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const { result } = transposeTab(at, score, { ...everything, tuning: 2 });
    expect(result.unplayable).toBe(0);
    expect(notes.map(where)).toEqual(original);
    expect(storedTuning(score, 0)).toEqual([26, 31, 36, 41]);
  });
});

describe("retuneTab", () => {
  it("re-frets the notes so they sound as before", async () => {
    const { at, score, notes } = await load();
    const pitches = notes.map((n) => n.realValue);
    const { step, result } = retuneTab(at, score, { track: 0, offsets: allStrings(2), keepPitch: true });
    expect(result.retuned[0].label).toBe("All strings down 2");
    expect(notes.map((n) => n.realValue)).toEqual(pitches);
    expect(notes[0].fret).toBe(7);
    expect(storedTuning(score, 0)).toEqual([26, 31, 36, 41]);
    restoreStep(step);
    expect(notes[0].fret).toBe(5);
    expect(storedTuning(score, 0)).toEqual([28, 33, 38, 43]);
  });

  it("keeps the frets and lets the pitch move", async () => {
    const { at, score, notes } = await load();
    const original = notes.map(where);
    const { step } = retuneTab(at, score, { track: 0, offsets: [2], keepPitch: false });
    expect(notes.map(where)).toEqual(original);
    expect(notes[1].realValue).toBe(26);
    expect(notes[0].realValue).toBe(38);
    restoreStep(step);
    expect(notes[1].realValue).toBe(28);
  });

  it("does nothing for the same tuning and refuses while the song is transposed", async () => {
    const { at, score } = await load();
    const same = retuneTab(at, score, { track: 0, offsets: [0, 0], keepPitch: true });
    expect(same.step).toEqual({ placements: [], tunings: [] });
    applyTranspose(at, score, 2);
    expect(() => retuneTab(at, score, { track: 0, offsets: [2], keepPitch: true })).toThrow(/Reset the song's transpose/);
  });
});
