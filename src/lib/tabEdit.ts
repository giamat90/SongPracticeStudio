import type * as AlphaTabModule from "@coderline/alphatab";

type AlphaTab = typeof AlphaTabModule;
export type TabNoteModel = AlphaTabModule.model.Note;
export type TabBarModel = AlphaTabModule.model.Bar;

/** The highest fret offered when a note is moved to another string. */
export const MAX_FRET = 24;

/** Where a note sits: model string (1 = the lowest string) and fret. */
export interface Placement {
  note: TabNoteModel;
  string: number;
  fret: number;
}

export interface StringChoice {
  /** Model string number (1 = the lowest string), what `Note.string` holds. */
  string: number;
  /** Fret of the note on that string; the pitch is the same. */
  fret: number;
}

export type Movability =
  | { ok: true; choices: StringChoice[] }
  | { ok: false; reason: string };

function staffOf(note: TabNoteModel) {
  return note.beat.voice.bar.staff;
}

/** MIDI pitch of a string played open, capo included: the same sum alphaTab uses for `Note.realValue`. */
function openPitch(note: TabNoteModel, string: number): number {
  const staff = staffOf(note);
  return staff.capo + staff.tuning[staff.tuning.length - string];
}

/** String number as a player counts it: 1 is the thinnest string, the top line of the tab. */
export function playerString(note: TabNoteModel, string: number): number {
  return staffOf(note).tuning.length - string + 1;
}

/**
 * The note and every note that only makes sense on the same string as it: the
 * other ends of a tie, a hammer-on / pull-off and a slide. They move together.
 */
export function linkedNotes(note: TabNoteModel): TabNoteModel[] {
  const seen = new Set<TabNoteModel>([note]);
  const queue = [note];
  while (queue.length > 0) {
    const n = queue.pop() as TabNoteModel;
    for (const next of [n.tieOrigin, n.tieDestination, n.hammerPullOrigin, n.hammerPullDestination, n.slideOrigin, n.slideTarget]) {
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return [...seen];
}

/** The strings a note can move to without changing what it sounds like, or why it cannot move. */
export function movability(note: TabNoteModel): Movability {
  const staff = staffOf(note);
  if (!note.isStringed || staff.isPercussion || staff.tuning.length === 0) {
    return { ok: false, reason: "Only notes on a fretted instrument can change string." };
  }
  const group = linkedNotes(note);
  if (group.some((n) => n.isHarmonic)) {
    return { ok: false, reason: "A harmonic sounds by its fret, so it stays where it is." };
  }
  if (group.some((n) => n.string !== note.string)) {
    return { ok: false, reason: "The tied or linked notes are on different strings." };
  }

  const members = new Set(group);
  const choices: StringChoice[] = [];
  for (let string = 1; string <= staff.tuning.length; string++) {
    if (string === note.string) continue;
    const shift = openPitch(note, string) - openPitch(note, note.string);
    const fits = group.every((n) => {
      const fret = n.fret - shift;
      const taken = n.beat.notes.some((other) => !members.has(other) && other.string === string);
      return fret >= 0 && fret <= MAX_FRET && !taken;
    });
    if (fits) choices.push({ string, fret: note.fret - shift });
  }
  choices.sort((a, b) => Math.abs(a.string - note.string) - Math.abs(b.string - note.string));
  if (choices.length === 0) return { ok: false, reason: "No other string plays this note." };
  return { ok: true, choices };
}

/**
 * The string next to the note's in a direction, as a player sees the tab: "up" is toward the thinnest string (the
 * top line), "down" toward the lowest. Strings that cannot play the pitch are skipped, as Guitar Pro does.
 */
export function stepString(note: TabNoteModel, direction: "up" | "down"): StringChoice | null {
  const result = movability(note);
  if (!result.ok) return null;
  const wanted = result.choices.filter((c) => (direction === "up" ? c.string > note.string : c.string < note.string));
  if (wanted.length === 0) return null;
  return wanted[0];
}

/**
 * The first note played in a bar, or null for a bar of rests. When a chord starts the bar, the note on the string
 * nearest to `near`'s, so stepping from bar to bar stays on the line the user was working on.
 */
export function firstNoteOfBar(bar: TabBarModel, near?: TabNoteModel | null): TabNoteModel | null {
  const beat = bar.voices[0]?.beats.find((b) => b.notes.length > 0);
  if (!beat) return null;
  if (!near) return beat.notes[0];
  const distance = (n: TabNoteModel) => Math.abs(n.string - near.string);
  return beat.notes.reduce((best, n) => (distance(n) < distance(best) ? n : best));
}

/** Move the note, and the notes linked to it, to a string at the same pitch. Returns what undoes it. */
export function moveToString(note: TabNoteModel, string: number): Placement[] {
  const result = movability(note);
  if (!result.ok) throw new Error(result.reason);
  if (!result.choices.some((c) => c.string === string)) {
    throw new Error(`String ${string} cannot play this note.`);
  }
  const shift = openPitch(note, string) - openPitch(note, note.string);
  const undo: Placement[] = [];
  for (const n of linkedNotes(note)) {
    undo.push({ note: n, string: n.string, fret: n.fret });
    n.fret -= shift;
    n.string = string;
  }
  return undo;
}

/** Put notes back where they were; returns what undoes that, so undo and redo are the same call. */
export function restore(placements: readonly Placement[]): Placement[] {
  return placements.map(({ note, string, fret }) => {
    const before: Placement = { note, string: note.string, fret: note.fret };
    note.string = string;
    note.fret = fret;
    return before;
  });
}

/** The score as a Guitar Pro 7 file, whatever format it was read from. */
export function exportTab(at: AlphaTab, score: AlphaTabModule.model.Score): Uint8Array {
  return new at.exporter.Gp7Exporter().export(score, new at.Settings());
}
