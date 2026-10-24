import { useEffect, useState } from "react";
import { getEngine } from "../../stores/player";
import { hitEnvelope } from "../../lib/meterView";
import type { Song } from "../../lib/types";

export const ENVELOPE_FPS = 100;
const CHUNK_SECONDS = 30;
/** How long to wait for the stems to be decoded: the player loads them one by one. */
const DECODE_WAIT_MS = 120_000;
const DECODE_POLL_MS = 500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The stems that carry the beat: the drums when there are any, else everything but the voice. */
export function beatStems(stems: readonly string[]): string[] {
  return stems.includes("drums") ? ["drums"] : stems.filter((s) => s !== "vocals");
}

/**
 * How strongly each hundredth of a second of the song's drums starts a sound, for the lane to draw under the bar
 * lines. Null until the stems are decoded and read; a song's whole length is read in pieces so the page stays live.
 */
export function useHitEnvelope(song: Song, enabled: boolean): Float32Array | null {
  const [values, setValues] = useState<Float32Array | null>(null);

  useEffect(() => {
    setValues(null);
    if (!enabled) return;
    const names = beatStems(song.stems);
    if (names.length === 0) return;
    let cancelled = false;

    const read = async () => {
      for (let waited = 0; waited < DECODE_WAIT_MS && !cancelled; waited += DECODE_POLL_MS) {
        if (getEngine().getStemSamples(names, 0, 0.05)) break;
        await sleep(DECODE_POLL_MS);
      }
      if (cancelled) return;
      const out = new Float32Array(Math.ceil(song.duration * ENVELOPE_FPS) + 1);
      for (let from = 0; from < song.duration && !cancelled; from += CHUNK_SECONDS) {
        const got = getEngine().getStemSamples(names, from, Math.min(song.duration, from + CHUNK_SECONDS));
        if (!got) continue;
        out.set(hitEnvelope(got.samples, got.sampleRate, ENVELOPE_FPS), Math.round(from * ENVELOPE_FPS));
        await sleep(0);
      }
      if (!cancelled) setValues(out);
    };

    read().catch((e: unknown) => console.error("[useHitEnvelope] reading the drums failed:", e));
    return () => { cancelled = true; };
  }, [song.id, song.duration, song.stems, enabled]);

  return values;
}
