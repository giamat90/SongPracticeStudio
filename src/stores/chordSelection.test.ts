import { beforeEach, describe, expect, it } from "vitest";
import { useChordSelection } from "./chordSelection";

beforeEach(() => useChordSelection.getState().clear());

describe("chord selection", () => {
  it("starts with nothing picked", () => {
    expect(useChordSelection.getState().index).toBeNull();
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
