import { barEnd, defaultGroups, formatGroups, formatSignature, meterRuns, type BarMap } from "@giamat90/mps-core/meter";

/** Height of the strip of bar buttons at the top of the lane, in the canvas's own pixels. */
export const STRIP_H = 28;
/** How near a bar's left edge counts as grabbing it. */
export const EDGE_HIT_PX = 7;

export interface BarBlock {
  index: number;
  x0: number;
  x1: number;
}

export type MeterPress =
  | { kind: "edge"; index: number }
  | { kind: "bar"; index: number }
  | { kind: "seek" };

/**
 * What a press on the lane lands on. The strip holds a button per bar; the left edge of a bar (drawn as a handle)
 * is grabbed to move where it starts, anywhere else on the strip picks the bar, and below the strip a press
 * goes to that time.
 */
export function classifyMeterPress(blocks: readonly BarBlock[], x: number, y: number): MeterPress {
  if (y > STRIP_H) return { kind: "seek" };
  const edge = blocks.find((b) => Math.abs(x - b.x0) <= EDGE_HIT_PX && x >= b.x0 - EDGE_HIT_PX);
  if (edge) return { kind: "edge", index: edge.index };
  const bar = blocks.find((b) => x > b.x0 && x < b.x1);
  return bar ? { kind: "bar", index: bar.index } : { kind: "seek" };
}

export type ApplyScope = "bar" | "run" | "end";

/** The bars an edit reaches: just the picked one, those up to where the signature changes, or all that follow. */
export function barRange(map: BarMap, index: number, scope: ApplyScope): [number, number] {
  if (scope === "bar") return [index, index];
  if (scope === "end") return [index, map.bars.length - 1];
  const sig = formatSignature(map.bars[index]);
  let last = index;
  while (last + 1 < map.bars.length && formatSignature(map.bars[last + 1]) === sig) last++;
  return [index, last];
}

/** `m:ss.s` for a place in the song. */
export function formatStamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${(seconds - m * 60).toFixed(1).padStart(4, "0")}`;
}

/** "7/8 (3+2+2)", or just "4/4" when the bar is not split into groups. */
export function barTitle(map: BarMap, index: number): string {
  const bar = map.bars[index];
  const groups = formatGroups(bar);
  return groups.includes("+") ? `${formatSignature(bar)} (${groups})` : formatSignature(bar);
}

const compositions = (n: number, parts: readonly number[]): number[][] => {
  if (n === 0) return [[]];
  return parts.filter((p) => p <= n).flatMap((p) => compositions(n - p, parts).map((rest) => [p, ...rest]));
};

/** The ways a bar of `num` pulses is commonly counted: the usual split first, then the other orders of twos and threes. */
export function groupPresets(num: number, limit = 6): number[][] {
  if (num <= 3) return [[num]];
  const usual = defaultGroups(num);
  const wanted = compositions(num, [2, 3, 4])
    .filter((g) => g.length > 1 || num <= 4)
    .sort((a, b) => Number(b.every((p) => p <= 3)) - Number(a.every((p) => p <= 3)) || a.length - b.length || b.join("").localeCompare(a.join("")));
  const key = (g: number[]) => g.join("+");
  const out = [usual, ...wanted.filter((g) => key(g) !== key(usual))];
  return out.slice(0, limit);
}

/** "3+2+2", "3 2 2" or "3,2,2" as groups of a bar of `num` pulses; null when they do not add up. */
export function parseGroups(text: string, num: number): number[] | null {
  const parts = text.split(/[^0-9]+/).filter((p) => p !== "").map(Number);
  if (parts.length === 0 || parts.some((p) => p < 1) || parts.reduce((a, b) => a + b, 0) !== num) return null;
  return parts;
}

/** "5, 7" or "5+7" as a pattern of bar lengths; null when empty or a length is not 1 to 32. */
export function parseCycle(text: string): number[] | null {
  const parts = text.split(/[^0-9]+/).filter((p) => p !== "").map(Number);
  if (parts.length === 0 || parts.length > 16 || parts.some((p) => p < 1 || p > 32)) return null;
  return parts;
}

export interface MeterShare {
  label: string;
  share: number;
  bars: number;
}

/** The signatures a song spends its time in, longest first, for the summary line. */
export function meterShares(map: BarMap): MeterShare[] {
  const byLabel = new Map<string, { time: number; bars: number }>();
  let total = 0;
  for (const run of meterRuns(map)) {
    const label = `${run.num}/${run.den}`;
    const entry = byLabel.get(label) ?? { time: 0, bars: 0 };
    entry.time += run.end - run.start;
    entry.bars += run.bars;
    total += run.end - run.start;
    byLabel.set(label, entry);
  }
  return [...byLabel.entries()]
    .map(([label, e]) => ({ label, share: total > 0 ? e.time / total : 0, bars: e.bars }))
    .sort((a, b) => b.share - a.share);
}

/** Where the bar's end falls, for an editor that shows its stretch. */
export const stretchOf = (map: BarMap, index: number): [number, number] => [map.bars[index].start, barEnd(map, index)];

/**
 * How strongly each short frame of a stem starts a sound: the rise of its loudness over the loudness just before.
 * Drawn under the bar lines, it shows whether a line lands on a hit.
 */
export function hitEnvelope(samples: Float32Array, sampleRate: number, fps = 100): Float32Array {
  const hop = Math.max(1, Math.round(sampleRate / fps));
  const frames = Math.floor(samples.length / hop);
  const loud = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop, end = i + hop; i < end; i++) sum += samples[i] * samples[i];
    loud[f] = Math.sqrt(sum / hop);
  }
  const out = new Float32Array(frames);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const before = ((loud[f - 1] ?? 0) + (loud[f - 2] ?? 0) + (loud[f - 3] ?? 0)) / 3;
    out[f] = Math.max(0, loud[f] - before);
    if (out[f] > peak) peak = out[f];
  }
  if (peak > 0) for (let f = 0; f < frames; f++) out[f] = Math.min(1, out[f] / (peak * 0.6));
  return out;
}
