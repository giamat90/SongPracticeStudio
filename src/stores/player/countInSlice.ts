import {
  COUNT_IN_LEAD_S,
  countInBpm,
  createCountInSlice as createSharedCountInSlice,
  steadyCountIn,
  type CountInPlan,
  type CountInSlice,
} from "@giamat90/mps-core/countIn";
import { clickSequence, countInMap, pulseTimes } from "@giamat90/mps-core/meter";
import type { Getter, Slice } from "./types";

export const createCountInSlice: Slice<CountInSlice> = (set, get) => createSharedCountInSlice(set, get);

// A song with bars is counted in the way its bars are counted: its own accents, its own number of pulses,
// taken from the bar playing at `startPos`. Without bars the count is steady beats at the song's tempo.
export function countInPlan(get: Getter, startPos: number): CountInPlan {
  const { song, playbackRate: rate, meterMap, countInBars: bars } = get();
  const counted = meterMap ? countInMap(meterMap, startPos, bars) : null;
  const sequence = counted ? clickSequence(counted, 0, rate) : null;
  if (!counted || !sequence) return steadyCountIn(countInBpm(song?.detectedBpm, rate), bars);
  const pulsesMs = counted.bars.flatMap((_, i) => pulseTimes(counted, i)).map((t) => (t / rate) * 1000);
  return {
    begin: (click) => click.startSequence({ ...sequence.first, wait: COUNT_IN_LEAD_S }, sequence.next),
    beats: pulsesMs.length,
    stepsMs: pulsesMs.slice(1),
    totalMs: (counted.end / rate) * 1000,
  };
}
