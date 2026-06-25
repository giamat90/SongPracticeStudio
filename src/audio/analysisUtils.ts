import type { PitchPoint, DynamicsPoint, TimingDeviation } from "../lib/types";
import { frequencyToMidi } from "../lib/constants";

/** Find the nearest pitch point at a given time (binary search). */
export function pitchAtTime(
  pitchData: PitchPoint[],
  time: number,
): PitchPoint | null {
  if (pitchData.length === 0) return null;
  let lo = 0, hi = pitchData.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pitchData[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0) {
    const prev = pitchData[lo - 1];
    const curr = pitchData[lo];
    return Math.abs(prev.time - time) < Math.abs(curr.time - time) ? prev : curr;
  }
  return pitchData[lo];
}

/** Find the nearest dynamics point at a given time. */
export function dynamicsAtTime(
  dynamics: DynamicsPoint[],
  time: number,
): DynamicsPoint | null {
  if (dynamics.length === 0) return null;
  let lo = 0, hi = dynamics.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dynamics[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return dynamics[lo];
}

/** Cents deviation between two frequencies. Positive = sharp. */
export function centsDeviation(freq: number, reference: number): number {
  if (reference <= 0 || freq <= 0) return 0;
  return 1200 * Math.log2(freq / reference);
}

/**
 * Match take onsets to song onsets and compute timing deviations.
 * Uses nearest-neighbor matching with a 500ms window.
 */
export function computeTimingDeviations(
  songOnsets: number[],
  takeOnsets: number[],
): TimingDeviation[] {
  const deviations: TimingDeviation[] = [];
  const WINDOW = 0.5; // seconds

  songOnsets.forEach((refTime, noteIndex) => {
    // Find nearest take onset within window
    let bestDelta = Infinity;
    let bestUserTime = refTime;
    for (const userTime of takeOnsets) {
      const delta = userTime - refTime;
      if (Math.abs(delta) < WINDOW && Math.abs(delta) < Math.abs(bestDelta)) {
        bestDelta = delta;
        bestUserTime = userTime;
      }
    }
    if (isFinite(bestDelta)) {
      deviations.push({
        noteIndex,
        referenceTime: refTime,
        userTime: bestUserTime,
        deltaMs: Math.round(bestDelta * 1000),
      });
    }
  });

  return deviations;
}

/** Average cents deviation (ignoring unvoiced frames). */
export function avgCentsDeviation(
  takePitch: PitchPoint[],
  songPitch: PitchPoint[],
  confidenceThreshold = 0.5,
): number {
  if (takePitch.length === 0 || songPitch.length === 0) return 0;
  let total = 0, count = 0;
  for (const tp of takePitch) {
    if (tp.confidence < confidenceThreshold) continue;
    const sp = pitchAtTime(songPitch, tp.time);
    if (!sp || sp.confidence < confidenceThreshold) continue;
    total += centsDeviation(tp.frequency, sp.frequency);
    count++;
  }
  return count > 0 ? total / count : 0;
}

/** Convert frequency to MIDI note name + cents offset. */
export function frequencyToNoteName(freq: number): { name: string; cents: number } {
  if (freq <= 0) return { name: "—", cents: 0 };
  const midi = frequencyToMidi(freq);
  const rounded = Math.round(midi);
  const cents = Math.round((midi - rounded) * 100);
  const noteNames = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
  const note = noteNames[((rounded % 12) + 12) % 12];
  const octave = Math.floor(rounded / 12) - 1;
  return { name: `${note}${octave}`, cents };
}
