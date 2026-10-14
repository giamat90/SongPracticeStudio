import type * as AlphaTabModule from "@coderline/alphatab";

type AlphaTab = typeof AlphaTabModule;

export type TabRole = "g" | "b" | "k" | "d";

/** [tick, duration in ticks, MIDI pitch (a drum's note number for "d"), role] */
export type TabNote = [number, number, number, TabRole];

export interface TabScoreBar {
  tick: number;
  end: number;
  /** Master bar index in the tab. */
  index: number;
  /** Which pass over the bar this is; 0 for the first. */
  occurrence: number;
}

/** The compact score the sidecar aligns: played bars, tempo map, and the notes that tell the song apart. */
export interface TabScore {
  version: 1;
  division: number;
  tempos: [number, number][];
  bars: TabScoreBar[];
  notes: TabNote[];
}

export interface TabTrackInfo {
  index: number;
  name: string;
  role: TabRole | null;
  /** How many notes the track plays, to tell a main part from a sparse extra. */
  noteCount: number;
}

const VOCAL_NAME = /vocal|vox|voice|choir|singer/i;

/** What a track contributes to the alignment: GM program ranges, with vocals and everything else left out. */
export function trackRole(program: number, isPercussion: boolean, name: string): TabRole | null {
  if (isPercussion) return "d";
  if (VOCAL_NAME.test(name)) return null;
  if (program >= 24 && program <= 31) return "g";
  if (program >= 32 && program <= 39) return "b";
  if (program >= 0 && program <= 23) return "k";
  return null;
}

export async function loadAlphaTab(): Promise<AlphaTab> {
  return import("@coderline/alphatab");
}

export function readScore(at: AlphaTab, bytes: Uint8Array): AlphaTabModule.model.Score {
  return at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
}

function countNotes(track: AlphaTabModule.model.Track): number {
  let count = 0;
  for (const staff of track.staves) {
    for (const bar of staff.bars) {
      for (const voice of bar.voices) {
        for (const beat of voice.beats) count += beat.notes.length;
      }
    }
  }
  return count;
}

export function tabTracks(score: AlphaTabModule.model.Score): TabTrackInfo[] {
  return score.tracks.map((t) => ({
    index: t.index,
    name: t.name,
    role: trackRole(t.playbackInfo.program, t.staves.some((s) => s.isPercussion), t.name),
    noteCount: countNotes(t),
  }));
}

/** The track to show first: the guitar with the most notes, else the busiest bass, else the busiest track. */
export function defaultTrack(tracks: readonly TabTrackInfo[]): number {
  const busiest = (list: readonly TabTrackInfo[]) => list.reduce<TabTrackInfo | undefined>(
    (best, t) => (!best || t.noteCount > best.noteCount ? t : best), undefined);
  const pick = busiest(tracks.filter((t) => t.role === "g"))
    ?? busiest(tracks.filter((t) => t.role === "b"))
    ?? busiest(tracks);
  return pick ? pick.index : 0;
}

/** Build the sidecar's score from a parsed tab, repeats expanded in play order. */
export function buildTabScore(at: AlphaTab, score: AlphaTabModule.model.Score): TabScore {
  const settings = new at.Settings();
  const midi = new at.midi.MidiFile();
  const generator = new at.midi.MidiFileGenerator(score, settings, new at.midi.AlphaSynthMidiFileHandler(midi));
  generator.generate();

  const roles = tabTracks(score).map((t) => t.role);
  const seen = new Map<number, number>();
  const bars: TabScoreBar[] = generator.tickLookup.masterBars.map((m) => {
    const index = m.masterBar.index;
    const occurrence = seen.get(index) ?? 0;
    seen.set(index, occurrence + 1);
    return { tick: m.start, end: m.end, index, occurrence };
  });

  const tempoAt = new Map<number, number>();
  const open = new Map<string, number[]>();
  const notes: TabNote[] = [];
  for (const e of midi.events) {
    if (e instanceof at.midi.TempoChangeEvent) {
      tempoAt.set(e.tick, e.beatsPerMinute);
    } else if (e instanceof at.midi.NoteOnEvent) {
      const key = `${e.track}:${e.channel}:${e.noteKey}`;
      const stack = open.get(key);
      if (stack) stack.push(e.tick);
      else open.set(key, [e.tick]);
    } else if (e instanceof at.midi.NoteOffEvent) {
      const stack = open.get(`${e.track}:${e.channel}:${e.noteKey}`);
      const start = stack?.shift();
      const role = roles[e.track];
      if (start !== undefined && role) notes.push([start, Math.max(1, e.tick - start), e.noteKey, role]);
    }
  }
  if (tempoAt.size === 0) tempoAt.set(0, score.tempo);
  const tempos = [...tempoAt.entries()].sort((a, b) => a[0] - b[0]);

  return { version: 1, division: midi.division, tempos, bars, notes };
}

/** Sync points for alphaTab from stored bar lines: one at the start of every played bar. */
export function flatSyncPoints(bars: readonly { index: number; occurrence: number; time: number }[]) {
  return bars.map((b) => ({
    barIndex: b.index,
    barPosition: 0,
    barOccurence: b.occurrence,
    millisecondOffset: Math.round(b.time * 1000),
  }));
}
