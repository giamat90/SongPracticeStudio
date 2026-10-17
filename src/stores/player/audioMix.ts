import { audibleTakes, type TakeSelection } from "@giamat90/mps-core/takes";
import type { AudioEngine } from "../../audio/engine";
import type { MixSource } from "../../lib/tauri";
import { getEngine } from "./singletons";
import type { PlayerStore } from "./types";

// Reserved mute/solo key for the recorded take track (shares the same
// mutedStems/soloedStem mechanism as the stems, so soloing either silences
// the rest — no stem is ever actually named this).
export const TAKE_TRACK_KEY = "__take__";

// Soloing a track silences every other track; muting silences only that
// track. Neither ever overwrites the stored slider value.
export function effectiveStemGain(
  name: string,
  rawVolume: number,
  mutedStems: Record<string, boolean>,
  soloedStem: string | null,
): number {
  if (soloedStem !== null) return name === soloedStem ? rawVolume : 0;
  if (mutedStems[name]) return 0;
  return rawVolume;
}

// Compute and push effective volume for every loaded stem, plus the take (if any).
export function applyEffectiveVolumes(
  eng: AudioEngine,
  stems: readonly string[],
  stemVolumes: Record<string, number>,
  mutedStems: Record<string, boolean>,
  soloedStem: string | null,
  takeVolume: number,
) {
  for (const name of stems) {
    eng.setStemVolume(name, effectiveStemGain(name, stemVolumes[name] ?? 1.0, mutedStems, soloedStem));
  }
  eng.setTakeVolume(effectiveStemGain(TAKE_TRACK_KEY, takeVolume, mutedStems, soloedStem));
}

// A take soloed on its own lane only chooses among the takes; it never touches the
// stems, and the take channel's own mute / solo state outranks it.
const soloedTakeOf = (s: { soloedTakeId: string | null }): string | null => s.soloedTakeId;

/** The takes as a whole are silent: the main take mute is on, or another track is soloed. */
export function takesSilenced(s: { mutedStems: Record<string, boolean>; soloedStem: string | null }): boolean {
  return effectiveStemGain(TAKE_TRACK_KEY, 1, s.mutedStems, s.soloedStem) === 0;
}

export const selectionOf = (s: { shownTakeIds: string[]; activeTakeId: string | null }): TakeSelection => ({
  shown: s.shownTakeIds,
  active: s.activeTakeId,
});

function audibleTakeSources(state: PlayerStore, takeGain: number): MixSource[] {
  // What is heard is what is mixed: every take that is audible right now.
  const audible = audibleTakes({
    shown: state.shownTakeIds,
    active: state.activeTakeId,
    playback: state.takePlayback,
    muted: state.mutedTakeIds,
    recording: false,
    muteWhileRecording: false,
    soloed: soloedTakeOf(state),
    silenced: false,
  });
  const sources: MixSource[] = [];
  for (const id of audible) {
    const take = state.takes.find((t) => t.id === id);
    if (!take) continue;
    sources.push({
      path: take.filepath,
      gain: takeGain * (state.takeGains[id] ?? 1),
      isTake: true,
      startPosition: take.startPosition,
      audioOffset: take.audioOffset ?? 0,
      manualOffset: take.manualOffset ?? 0,
    });
  }
  return sources;
}

/**
 * Build the source list for an "export mix" render from the current store
 * state: one entry per stem/take with nonzero effective volume, resolved to
 * the underlying file path (and take alignment fields, if applicable).
 * Returns null if no track is currently audible.
 */
export function buildMixSources(state: PlayerStore): {
  sources: MixSource[];
  startSec: number;
  endSec: number;
} | null {
  const { song, stemVolumes, mutedStems, soloedStem, takeVolume } = state;
  if (!song) return null;

  const sources: MixSource[] = [];

  for (const name of song.stems) {
    const gain = effectiveStemGain(name, stemVolumes[name] ?? 1.0, mutedStems, soloedStem);
    if (gain > 0) {
      sources.push({ path: `${song.directory}/${name}.wav`, gain, isTake: false });
    }
  }

  const takeGain = effectiveStemGain(TAKE_TRACK_KEY, takeVolume, mutedStems, soloedStem);
  if (takeGain > 0) sources.push(...audibleTakeSources(state, takeGain));

  if (sources.length === 0) return null;

  return {
    sources,
    startSec: state.punchIn ?? 0,
    endSec: state.punchOut ?? state.duration,
  };
}

export function pushTakeAudio(state: PlayerStore): void {
  const eng = getEngine();
  eng.setActiveTakeTrack(state.activeTakeId);
  eng.setTakeGains(state.takeGains);
  eng.setAudibleTakeTracks(
    audibleTakes({
      shown: state.shownTakeIds,
      active: state.activeTakeId,
      playback: state.takePlayback,
      muted: state.mutedTakeIds,
      recording: state.isRecording,
      muteWhileRecording: state.muteTakesWhileRecording,
      soloed: soloedTakeOf(state),
      silenced: takesSilenced(state),
    }),
  );
}

// What is heard follows from the takes shown, the selection, the playback mode,
// the lane mutes and whether a recording is under way. Derived here, once, so no
// action has to remember to tell the engine.
export function takeAudioInputsChanged(state: PlayerStore, prev: PlayerStore): boolean {
  return !(
    state.shownTakeIds === prev.shownTakeIds &&
    state.activeTakeId === prev.activeTakeId &&
    state.takePlayback === prev.takePlayback &&
    state.mutedTakeIds === prev.mutedTakeIds &&
    state.soloedTakeId === prev.soloedTakeId &&
    state.soloedStem === prev.soloedStem &&
    state.mutedStems === prev.mutedStems &&
    state.takeGains === prev.takeGains &&
    state.isRecording === prev.isRecording &&
    state.muteTakesWhileRecording === prev.muteTakesWhileRecording
  );
}
