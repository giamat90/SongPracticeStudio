import type * as AlphaTabModule from "@coderline/alphatab";
import {
  MAX_FRET, exportTab, linkedNotes, moveToString, movability, restoreStep,
  type EditStep, type TabNoteModel,
} from "./tabEdit";

type AlphaTab = typeof AlphaTabModule;
type Score = AlphaTabModule.model.Score;
type Staff = AlphaTabModule.model.Staff;

/** The most the lowest string is tuned down to fit a transposition (a bass E to a low B at most). */
export const MAX_RETUNE = 5;

/** The most the whole instrument is tuned down to fit a transposition. */
export const MAX_ALL_DOWN = 4;

/** More strings than any instrument here has: an "every string" preset is this long and cut to the track's strings. */
const MAX_STRINGS = 12;

/** Semitones each string is tuned down from the tab's tuning, lowest string first; a missing entry is 0, a negative one tunes up. */
export type Offsets = readonly number[];

/** A tuning for a track: its offsets from the tab's tuning, what it is called, and the note names before and after. */
export interface Retune {
  offsets: number[];
  /** Notes the tuning makes playable (a suggestion), or 0. */
  fixes: number;
  label: string;
  /** Open strings, lowest first, before and after: "E A D G". */
  from: string;
  to: string;
}

/** Every string tuned down by `semitones`. */
export const allStrings = (semitones: number): number[] => Array<number>(MAX_STRINGS).fill(semitones);

/** Only the lowest string tuned down by `semitones` (Drop D is 2). */
export const lowestString = (semitones: number): number[] => [semitones];

export const hasOffsets = (offsets: Offsets | undefined): boolean => !!offsets && offsets.some((v) => v !== 0);

/** What a set of offsets does, in words, for a track with `strings` strings. */
export function describeOffsets(offsets: Offsets, strings: number): string {
  const o = Array.from({ length: strings }, (_, i) => offsets[i] ?? 0);
  const changed = o.filter((v) => v !== 0);
  const way = (n: number) => `${n > 0 ? "down" : "up"} ${Math.abs(n)}`;
  if (changed.length === 0) return "Same tuning";
  if (changed.length === strings && o.every((v) => v === o[0])) return `All strings ${way(o[0])}`;
  if (changed.length === 1 && o[0] !== 0) return `Lowest string ${way(o[0])}`;
  return "Custom tuning";
}

/** The name of a pitch as alphaTab spells a string: "E". */
export const pitchName = (at: AlphaTab, pitch: number): string => at.model.Tuning.getTextForTuning(pitch, false);

/** What a transposition did to the score's fretted notes. */
export interface TransposeResult {
  /** Notes that stayed on their string with a new fret. */
  sameString: number;
  /** Notes that had to change string to stay between the nut and the 24th fret. */
  newString: number;
  /** Notes no string of the tuning can play (below the lowest open string, or a harmonic), left as they were and drawn red. */
  unplayable: number;
  /** Saved string choices put back on their notes. */
  edited: number;
  /** Saved string choices that no longer fit the tab (the note or the string is gone) and were left out. */
  stale: number;
  /** The unplayable notes, by track index. */
  unplayableByTrack: Record<number, number>;
  /** By track index: tunings that would make more of the unplayable notes playable, best first. */
  suggestions: Record<number, Retune[]>;
  /** By track index: the tuning this run plays the track in, when it is not the tab's. */
  retuned: Record<number, Retune>;
}

/**
 * A string the user chose for one note of a transposed song. The note is found by where it sits in the tab and the
 * pitch it has in the stored (untransposed) tab, so it survives edits that only move notes between strings.
 */
export interface TransposeEdit {
  track: number;
  staff: number;
  bar: number;
  voice: number;
  beat: number;
  /** MIDI pitch in the stored tab, before the transposition. */
  pitch: number;
  /** Model string (1 = the lowest) the note was moved to. */
  string: number;
}

export interface TransposeOptions {
  /** String choices the user saved for this transposition. */
  edits?: readonly TransposeEdit[];
  /** The tuning to play each track in, per track index, as offsets from the tab's tuning. */
  retune?: Readonly<Record<number, Offsets>>;
  /** Try the note's own string first (default), else the position with the lowest fret. */
  keepStrings?: boolean;
}

/** The Transposition command: rewrite the stored tab by some semitones. */
export interface TabTransposition {
  semitones: number;
  /** Track index, or every track. */
  tracks: number | "all";
  keepStrings: boolean;
  /** Keep the tuning, pick the best one for the notes that do not fit, or tune every string down by this many semitones. */
  tuning: "keep" | "auto" | number;
}

/** The Tuning command: give a track other open strings, in the stored tab. */
export interface TabRetune {
  track: number;
  offsets: Offsets;
  /** Re-fret the notes so they sound as before; else the frets stay and the pitch moves. */
  keepPitch: boolean;
}

interface Applied extends EditStep {
  semitones: number;
  styles: { note: TabNoteModel; style: TabNoteModel["style"] }[];
  /** Where the automatic pass put every note it moved; a note elsewhere than here carries a user edit. */
  auto: Map<TabNoteModel, number>;
  /** Notes the user cannot move while transposed: drawn red, or with no pitch to move. */
  fixed: Set<TabNoteModel>;
}

interface RunOptions {
  retune: Readonly<Record<number, Offsets>>;
  keepStrings: boolean;
  /** Track indexes to change, or every track. */
  tracks: ReadonlySet<number> | null;
  /** Draw unplayable notes red (the live view) instead of keeping their pitch (a rewrite). */
  mark: boolean;
}

function emptyResult(): TransposeResult {
  return { sameString: 0, newString: 0, unplayable: 0, edited: 0, stale: 0, unplayableByTrack: {}, suggestions: {}, retuned: {} };
}

function emptyApplied(semitones: number): Applied {
  return { semitones, placements: [], tunings: [], styles: [], auto: new Map(), fixed: new Set() };
}

/** The transposition currently drawn into each score, so it can be taken back before the score is saved or reloaded. */
const applied = new WeakMap<Score, Applied>();

/** Rendering colour of a note no string can play. */
const UNPLAYABLE = { r: 255, g: 77, b: 77 };

function isFretted(note: TabNoteModel): boolean {
  const staff = note.beat.voice.bar.staff;
  return note.isStringed && !staff.isPercussion && staff.tuning.length > 0;
}

const isFrettedStaff = (staff: Staff): boolean => !staff.isPercussion && staff.tuning.length > 0;

const lowestFirst = (tunings: readonly number[]): number[] => [...tunings].reverse();

/**
 * The open strings of a track in the tab as stored, lowest first (capo left out), whatever a transposition has done to
 * the live score. Null for a track with no strings.
 */
export function storedTuning(score: Score, trackIndex: number): number[] | null {
  const staff = score.tracks[trackIndex]?.staves.find(isFrettedStaff);
  if (!staff) return null;
  const swap = applied.get(score)?.tunings.find((t) => t.staff === staff);
  return lowestFirst(swap ? swap.tuning.tunings : staff.tuning);
}

/**
 * Where a group of linked notes (a tie, hammer-on or slide stay on one string) lands after `semitones`: the same
 * string when every fret stays between the nut and the 24th, else the nearest string where it does and no other note of
 * the beat sits. Without `keepStrings` the string with the lowest fret comes first. Null when no string works.
 * `oldOpen` / `newOpen` are the open pitches of a string before and after a retune.
 */
function target(
  group: readonly TabNoteModel[], semitones: number, keepStrings: boolean,
  oldOpen: (string: number) => number, newOpen: (string: number) => number,
): { string: number; shift: number } | null {
  const first = group[0];
  const strings = first.beat.voice.bar.staff.tuning.length;
  const members = new Set(group);
  const shiftOn = (string: number) => newOpen(string) - oldOpen(first.string) - semitones;
  const distance = (string: number) => Math.abs(string - first.string);
  const order = Array.from({ length: strings }, (_, i) => i + 1).sort((a, b) =>
    keepStrings ? distance(a) - distance(b) : (first.fret - shiftOn(a)) - (first.fret - shiftOn(b)) || distance(a) - distance(b));
  for (const string of order) {
    const shift = shiftOn(string);
    const fits = group.every((n) => {
      const fret = n.fret - shift;
      const taken = string !== n.string && n.beat.notes.some((other) => !members.has(other) && other.string === string);
      return fret >= 0 && fret <= MAX_FRET && !taken;
    });
    if (fits) return { string, shift };
  }
  return null;
}

/** Take a run back: notes, strings, tunings and colours as they were. */
function undo(done: Applied): void {
  restoreStep({ placements: done.placements, tunings: done.tunings });
  for (const { note, style } of done.styles) note.style = style;
}

/** Give a staff other open strings (a new `Tuning`, the shared preset is never changed) and record how to put it back. */
function retuneStaff(at: AlphaTab, staff: Staff, offsets: Offsets, done: EditStep): Retune {
  const strings = staff.tuning.length;
  const old = staff.stringTuning;
  done.tunings.push({ staff, tuning: old });
  staff.stringTuning = new at.model.Tuning(old.name, old.tunings.map((v, i) => v - (offsets[strings - 1 - i] ?? 0)), false);
  const names = (tunings: readonly number[]) => lowestFirst(tunings).map((v) => pitchName(at, v)).join(" ");
  return {
    offsets: Array.from({ length: strings }, (_, i) => offsets[i] ?? 0),
    fixes: 0,
    label: describeOffsets(offsets, strings),
    from: names(old.tunings),
    to: names(staff.stringTuning.tunings),
  };
}

/**
 * Re-fret the fretted notes of the score (or of some tracks) for `semitones`, changing the live model. Returns what
 * to restore it with; nothing is remembered here.
 */
function run(at: AlphaTab, score: Score, semitones: number, o: RunOptions): { done: Applied; result: TransposeResult } {
  const result = emptyResult();
  const done = emptyApplied(semitones);
  const seen = new Set<TabNoteModel>();
  const paint = (note: TabNoteModel) => {
    done.styles.push({ note, style: note.style });
    const style = new at.model.NoteStyle();
    const colour = new at.model.Color(UNPLAYABLE.r, UNPLAYABLE.g, UNPLAYABLE.b, 255);
    style.colors.set(at.model.NoteSubElement.GuitarTabFretNumber, colour);
    style.colors.set(at.model.NoteSubElement.StandardNotationNoteHead, colour);
    note.style = style;
  };

  for (const track of score.tracks) {
    if (o.tracks && !o.tracks.has(track.index)) continue;
    const offsets = o.retune[track.index] ?? [];
    for (const staff of track.staves) {
      if (!isFrettedStaff(staff)) continue;
      const strings = staff.tuning.length;
      const down = (string: number) => offsets[string - 1] ?? 0;
      const oldOpen = (string: number) => staff.capo + staff.tuning[strings - string];
      const newOpen = (string: number) => oldOpen(string) - down(string);

      for (const bar of staff.bars) {
        for (const voice of bar.voices) {
          for (const beat of voice.beats) {
            for (const note of beat.notes) {
              if (seen.has(note) || !isFretted(note)) continue;
              const group = linkedNotes(note);
              for (const n of group) seen.add(n);
              // A dead note has no pitch to move.
              if (group.some((n) => n.isDead)) {
                for (const n of group) done.fixed.add(n);
                continue;
              }

              const to = group.some((n) => n.isHarmonic || n.string !== note.string)
                ? null
                : target(group, semitones, o.keepStrings, oldOpen, newOpen);
              if (!to) {
                for (const n of group) {
                  const fret = n.fret + down(n.string);
                  if (o.mark) {
                    paint(n);
                  } else if (down(n.string) !== 0 && !n.isHarmonic && fret >= 0 && fret <= MAX_FRET) {
                    // Left as written, but on a string that is tuned: keep the pitch it had.
                    done.placements.push({ note: n, string: n.string, fret: n.fret });
                    n.fret = fret;
                  }
                  done.fixed.add(n);
                }
                result.unplayable += group.length;
                result.unplayableByTrack[track.index] = (result.unplayableByTrack[track.index] ?? 0) + group.length;
                continue;
              }
              const stays = to.string === note.string;
              for (const n of group) {
                done.placements.push({ note: n, string: n.string, fret: n.fret });
                n.fret -= to.shift;
                n.string = to.string;
                done.auto.set(n, to.string);
              }
              if (stays) result.sameString += group.length;
              else result.newString += group.length;
            }
          }
        }
      }

      if (hasOffsets(offsets)) result.retuned[track.index] = retuneStaff(at, staff, offsets, done);
    }
  }
  return { done, result };
}

/** The tunings tried to make more notes playable: the lowest string down, or the whole instrument down. */
const CANDIDATES: { kind: "lowest" | "all"; down: number; offsets: number[] }[] = [
  ...Array.from({ length: MAX_RETUNE }, (_, i) => ({ kind: "lowest" as const, down: i + 1, offsets: lowestString(i + 1) })),
  ...Array.from({ length: MAX_ALL_DOWN }, (_, i) => ({ kind: "all" as const, down: i + 1, offsets: allStrings(i + 1) })),
];

/**
 * For each track with unplayable notes, the tunings that play more of them: per kind (lowest string down, whole
 * instrument down) the smallest drop that plays the most, best first, ties to the smaller change. Each is tried on the
 * score as it was before, and taken back.
 */
function suggest(
  at: AlphaTab, score: Score, semitones: number, o: RunOptions, base: Record<number, number>,
): Record<number, Retune[]> {
  const tracks = Object.keys(base).map(Number).filter((t) => base[t] > 0 && !hasOffsets(o.retune[t]));
  if (tracks.length === 0) return {};
  const found: Record<number, { kind: "lowest" | "all"; down: number; retune: Retune }[]> = {};
  for (const c of CANDIDATES) {
    const retune = { ...o.retune };
    for (const t of tracks) retune[t] = c.offsets;
    const trial = run(at, score, semitones, { ...o, retune, mark: false });
    undo(trial.done);
    for (const t of tracks) {
      const fixes = base[t] - (trial.result.unplayableByTrack[t] ?? 0);
      const shown = trial.result.retuned[t];
      if (fixes > 0 && shown) (found[t] ??= []).push({ kind: c.kind, down: c.down, retune: { ...shown, fixes } });
    }
  }
  const suggestions: Record<number, Retune[]> = {};
  for (const t of tracks) {
    const best = (["lowest", "all"] as const)
      .map((kind) => (found[t] ?? [])
        .filter((f) => f.kind === kind)
        .sort((a, b) => b.retune.fixes - a.retune.fixes || a.down - b.down)[0])
      .filter((f) => f !== undefined)
      .sort((a, b) => b.retune.fixes - a.retune.fixes);
    if (best.length > 0) suggestions[t] = best.map((f) => f.retune);
  }
  return suggestions;
}

function locate(note: TabNoteModel, semitones: number): Omit<TransposeEdit, "string"> {
  const beat = note.beat;
  const bar = beat.voice.bar;
  return {
    track: bar.staff.track.index,
    staff: bar.staff.index,
    bar: bar.index,
    voice: beat.voice.index,
    beat: beat.index,
    pitch: note.realValue - semitones,
  };
}

/** The note a saved choice is for, among the notes the automatic pass moved. */
function find(score: Score, done: Applied, edit: TransposeEdit): TabNoteModel | null {
  const beat = score.tracks[edit.track]?.staves[edit.staff]?.bars[edit.bar]?.voices[edit.voice]?.beats[edit.beat];
  return beat?.notes.find((n) => done.auto.has(n) && n.realValue - done.semitones === edit.pitch) ?? null;
}

/** Whether a note of the transposed score can be moved to another string by the user. */
export function canEditTransposed(score: Score, note: TabNoteModel): boolean {
  const done = applied.get(score);
  return !done || !done.fixed.has(note);
}

/** The string choices the user made on the transposed score, to be saved for this transposition. */
export function transposeEdits(score: Score): TransposeEdit[] {
  const done = applied.get(score);
  if (!done) return [];
  const edits: TransposeEdit[] = [];
  for (const [note, string] of done.auto) {
    if (note.string !== string) edits.push({ ...locate(note, done.semitones), string: note.string });
  }
  return edits;
}

/** Put a score back as it was imported or edited, before any transposition. */
export function clearTranspose(score: Score): void {
  const done = applied.get(score);
  if (!done) return;
  undo(done);
  applied.delete(score);
}

/**
 * Re-fret every fretted note of the score for a song transposed by `semitones`: the same string with the fret moved by
 * the interval, else the nearest string that can play it. A note nothing can play keeps its place and is drawn red; the
 * result lists the tunings that would play more of them. The stored file is never touched; this changes the live model,
 * and `clearTranspose` / `exportUntransposed` undo it. `options.edits` are string choices the user saved for this
 * transposition, put on their notes after the automatic pass; `options.retune` plays tracks in other tunings.
 */
export function applyTranspose(at: AlphaTab, score: Score, semitones: number, options: TransposeOptions = {}): TransposeResult {
  clearTranspose(score);
  if (semitones === 0) return emptyResult();

  const o: RunOptions = { retune: options.retune ?? {}, keepStrings: options.keepStrings ?? true, tracks: null, mark: true };
  const first = run(at, score, semitones, { ...o, mark: false });
  undo(first.done);
  const suggestions = first.result.unplayable > 0 ? suggest(at, score, semitones, o, first.result.unplayableByTrack) : {};

  const { done, result } = run(at, score, semitones, o);
  result.suggestions = suggestions;
  applied.set(score, done);

  for (const edit of options.edits ?? []) {
    const note = find(score, done, edit);
    if (!note) {
      result.stale++;
      continue;
    }
    if (note.string !== edit.string) {
      const choices = movability(note);
      if (!choices.ok || !choices.choices.some((c) => c.string === edit.string)) {
        result.stale++;
        continue;
      }
      moveToString(note, edit.string);
    }
    result.edited++;
  }
  return result;
}

/**
 * The Transposition command: rewrite the stored tab by `semitones`, as Guitar Pro and TuxGuitar do. The score must not
 * be showing a song transposition. Notes nothing can play stay as written (their pitch kept when their string was
 * tuned). Returns what undoes it.
 */
export function transposeTab(at: AlphaTab, score: Score, t: TabTransposition): { step: EditStep; result: TransposeResult } {
  if (applied.has(score)) throw new Error("Reset the song's transpose before transposing the tab itself.");
  if (t.semitones === 0) return { step: { placements: [], tunings: [] }, result: emptyResult() };

  const tracks = t.tracks === "all" ? null : new Set([t.tracks]);
  const o: RunOptions = { retune: {}, keepStrings: t.keepStrings, tracks, mark: false };
  const retune: Record<number, Offsets> = {};
  if (typeof t.tuning === "number") {
    if (t.tuning !== 0) for (const track of score.tracks) if (!tracks || tracks.has(track.index)) retune[track.index] = allStrings(t.tuning);
  } else if (t.tuning === "auto") {
    const first = run(at, score, t.semitones, o);
    undo(first.done);
    if (first.result.unplayable > 0) {
      for (const [track, list] of Object.entries(suggest(at, score, t.semitones, o, first.result.unplayableByTrack))) {
        retune[Number(track)] = list[0].offsets;
      }
    }
  }
  const { done, result } = run(at, score, t.semitones, { ...o, retune });
  return { step: { placements: done.placements, tunings: done.tunings }, result };
}

/** What `transposeTab` would do, without keeping it. */
export function previewTransposition(at: AlphaTab, score: Score, t: TabTransposition): TransposeResult {
  const { step, result } = transposeTab(at, score, t);
  restoreStep(step);
  return result;
}

/**
 * The Tuning command: give a track other open strings in the stored tab. With `keepPitch` the notes are re-fretted to
 * sound as before (a note that no string can play keeps its place); without it the frets stay and the pitch moves.
 */
export function retuneTab(at: AlphaTab, score: Score, t: TabRetune): { step: EditStep; result: TransposeResult } {
  if (applied.has(score)) throw new Error("Reset the song's transpose before changing the tab's tuning itself.");
  if (!hasOffsets(t.offsets)) return { step: { placements: [], tunings: [] }, result: emptyResult() };

  if (t.keepPitch) {
    const { done, result } = run(at, score, 0, { retune: { [t.track]: t.offsets }, keepStrings: true, tracks: new Set([t.track]), mark: false });
    return { step: { placements: done.placements, tunings: done.tunings }, result };
  }
  const done = emptyApplied(0);
  const result = emptyResult();
  for (const staff of score.tracks[t.track]?.staves ?? []) {
    if (isFrettedStaff(staff)) result.retuned[t.track] = retuneStaff(at, staff, t.offsets, done);
  }
  return { step: { placements: [], tunings: done.tunings }, result };
}

/** The score as a Guitar Pro 7 file, with any transposition taken out of it for the export and put back after. */
export function exportUntransposed(at: AlphaTab, score: Score): Uint8Array {
  const done = applied.get(score);
  if (!done) return exportTab(at, score);
  const painted = done.styles.map(({ note }) => ({ note, style: note.style }));
  const held = restoreStep({ placements: done.placements, tunings: done.tunings });
  for (const { note, style } of done.styles) note.style = style;
  try {
    return exportTab(at, score);
  } finally {
    restoreStep(held);
    for (const { note, style } of painted) note.style = style;
  }
}
