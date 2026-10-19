import { beforeEach, describe, expect, it } from "vitest";
import { useChordSelection } from "./chordSelection";

beforeEach(() => useChordSelection.getState().clear());

describe("chord selection", () => {
  it("starts with nothing picked or tried", () => {
    expect(useChordSelection.getState()).toMatchObject({ index: null, candidate: null });
  });

  it("picks a chord", () => {
    useChordSelection.getState().toggle(2);
    expect(useChordSelection.getState().index).toBe(2);
  });

  it("puts the chord away when it is clicked again", () => {
    useChordSelection.getState().toggle(2);
    useChordSelection.getState().toggle(2);
    expect(useChordSelection.getState().index).toBeNull();
  });

  it("picking another chord replaces the first", () => {
    useChordSelection.getState().select(1);
    useChordSelection.getState().toggle(5);
    expect(useChordSelection.getState().index).toBe(5);
  });

  it("clears", () => {
    useChordSelection.getState().select(3);
    useChordSelection.getState().clear();
    expect(useChordSelection.getState().index).toBeNull();
  });
});

describe("the chord being tried", () => {
  it("is remembered with the chord it is tried on", () => {
    useChordSelection.getState().setCandidate(4, "C:sus2");
    expect(useChordSelection.getState().candidate).toEqual({ index: 4, chord: "C:sus2" });
  });

  it("is put away by null", () => {
    useChordSelection.getState().setCandidate(4, "C:sus2");
    useChordSelection.getState().setCandidate(4, null);
    expect(useChordSelection.getState().candidate).toBeNull();
  });

  it("does not follow the user to another chord", () => {
    useChordSelection.getState().setCandidate(4, "C:sus2");
    useChordSelection.getState().toggle(5);
    expect(useChordSelection.getState().candidate).toBeNull();
    useChordSelection.getState().setCandidate(5, "G:maj");
    useChordSelection.getState().clear();
    expect(useChordSelection.getState().candidate).toBeNull();
  });
});
