import { describe, it, expect } from "vitest";
import {
  DETACHABLE_PANELS,
  detachedLabel,
  isDetachablePanel,
  isSharedState,
  isStateMessage,
  panelFromLabel,
  parseCommand,
} from "./protocol";

const shared = { song: null, duration: 120, activeTakeId: null, shownTakeIds: [], takes: [] };
const transport = { time: 1, playing: false, rate: 1, sentAt: 100 };

describe("detachable panels", () => {
  it("are the three optional panels of the analyzer page", () => {
    expect([...DETACHABLE_PANELS]).toEqual(["chords", "lyrics", "takes"]);
  });

  it("round-trip through the window label", () => {
    for (const id of DETACHABLE_PANELS) expect(panelFromLabel(detachedLabel(id))).toBe(id);
  });

  it("are the only labels a window may carry", () => {
    for (const label of ["main", "detached-", "detached-stems", "detached-pianoRoll", "detached-lyrics-2"]) {
      expect(panelFromLabel(label), label).toBeNull();
    }
    expect(isDetachablePanel("stems")).toBe(false);
  });
});

describe("parseCommand", () => {
  it("accepts the four commands a detached panel may send", () => {
    expect(parseCommand({ type: "seek", time: 12.5 })).toEqual({ type: "seek", time: 12.5 });
    expect(parseCommand({ type: "toggleTake", id: "t1" })).toEqual({ type: "toggleTake", id: "t1" });
    expect(parseCommand({ type: "deleteTake", id: "t1" })).toEqual({ type: "deleteTake", id: "t1" });
    expect(parseCommand({ type: "renameTake", id: "t1", name: "Verse" })).toEqual({
      type: "renameTake",
      id: "t1",
      name: "Verse",
    });
  });

  it("keeps only the fields it knows, so nothing else is passed on", () => {
    expect(parseCommand({ type: "seek", time: 3, path: "C:/x", __proto__: { a: 1 } })).toEqual({ type: "seek", time: 3 });
  });

  it("rejects commands that are not ours, including the VPS-only ones", () => {
    for (const bad of [null, [], "seek", {}, { type: "setPunchIn", time: 1 }, { type: "clearPunch" }, { type: "eval", code: "1" }]) {
      expect(parseCommand(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("rejects a seek to a time that is not a place in the song", () => {
    for (const time of [-1, Number.NaN, Number.POSITIVE_INFINITY, "3", null]) {
      expect(parseCommand({ type: "seek", time })).toBeNull();
    }
  });

  it("rejects ids that are empty, too long or not strings", () => {
    for (const id of ["", "x".repeat(129), 7, null, undefined]) {
      expect(parseCommand({ type: "deleteTake", id })).toBeNull();
    }
  });

  it("rejects a name that is too long or not text", () => {
    expect(parseCommand({ type: "renameTake", id: "t", name: "x".repeat(201) })).toBeNull();
    expect(parseCommand({ type: "renameTake", id: "t", name: 5 })).toBeNull();
    expect(parseCommand({ type: "renameTake", id: "t", name: "" })).toEqual({ type: "renameTake", id: "t", name: "" });
  });
});

describe("shared state", () => {
  it("accepts a complete state", () => {
    expect(isSharedState(shared)).toBe(true);
    expect(isSharedState({ ...shared, activeTakeId: "t1", takes: [{ id: "t1" }] })).toBe(true);
  });

  it("rejects what is incomplete or mistyped", () => {
    for (const bad of [
      null,
      {},
      { ...shared, duration: "120" },
      { ...shared, duration: Number.NaN },
      { ...shared, activeTakeId: 3 },
      { ...shared, shownTakeIds: "t1" },
      { ...shared, shownTakeIds: [""] },
      { ...shared, shownTakeIds: undefined },
      { ...shared, takes: {} },
      { ...shared, takes: [{ name: "no id" }] },
      { ...shared, song: 7 },
    ]) {
      expect(isSharedState(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("is only a state message together with a valid transport", () => {
    expect(isStateMessage({ transport, shared })).toBe(true);
    expect(isStateMessage({ transport: { ...transport, time: "1" }, shared })).toBe(false);
    expect(isStateMessage({ transport, shared: { ...shared, takes: 1 } })).toBe(false);
  });
});
