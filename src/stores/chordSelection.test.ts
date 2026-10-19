import { beforeEach, describe, expect, it } from "vitest";
import { useChordSelection } from "./chordSelection";

beforeEach(() => useChordSelection.getState().clear());

describe("chord selection", () => {
  it("starts with nothing picked", () => {
    expect(useChordSelection.getState()).toMatchObject({ index: null, surface: null });
  });

  it("remembers where a chord was picked", () => {
    useChordSelection.getState().toggle(2, "roll");
    expect(useChordSelection.getState()).toMatchObject({ index: 2, surface: "roll" });
  });

  it("puts the chord away when it is clicked again in the same place", () => {
    useChordSelection.getState().toggle(2, "roll");
    useChordSelection.getState().toggle(2, "roll");
    expect(useChordSelection.getState()).toMatchObject({ index: null, surface: null });
  });

  it("moves the editor to the other place when the same chord is clicked there", () => {
    useChordSelection.getState().toggle(2, "roll");
    useChordSelection.getState().toggle(2, "row");
    expect(useChordSelection.getState()).toMatchObject({ index: 2, surface: "row" });
  });

  it("picking another chord replaces the first", () => {
    useChordSelection.getState().select(1, "row");
    useChordSelection.getState().toggle(5, "row");
    expect(useChordSelection.getState().index).toBe(5);
  });
});
