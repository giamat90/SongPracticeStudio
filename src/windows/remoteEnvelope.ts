import { create } from "zustand";
import { isNumber, isObject } from "@giamat90/mps-core/windows";

/** The drum hit envelope a detached Meter window was sent by the main window (it has no decoded stems to read). */
export const useRemoteEnvelope = create<{ songId: string | null; values: Float32Array | null }>(() => ({
  songId: null,
  values: null,
}));

/** Reads an `mps:envelope` message; anything malformed is ignored. */
export function receiveEnvelope(payload: unknown, fps: number): void {
  if (!isObject(payload) || typeof payload.songId !== "string" || payload.fps !== fps || !Array.isArray(payload.values)) {
    console.warn("[detached] ignoring a malformed envelope message");
    return;
  }
  if (!payload.values.every(isNumber)) {
    console.warn("[detached] ignoring an envelope with values that are not numbers");
    return;
  }
  useRemoteEnvelope.setState({ songId: payload.songId, values: Float32Array.from(payload.values as number[]) });
}
