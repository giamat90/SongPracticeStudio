import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

const fresh = () => import("./topbar");

describe("top bar cards", () => {
  it("starts in the order the bar was designed in", async () => {
    const { useTopbarOrder } = await fresh();
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose", "chords"]);
  });

  it("has no fixed lines: any card can be put in the place of any other", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("chords", "transport");
    expect(useTopbarOrder.getState().order).toEqual(["chords", "transport", "loop", "tempo", "devices", "transpose"]);
    useTopbarOrder.getState().move("transport", "devices");
    expect(useTopbarOrder.getState().order).toEqual(["chords", "loop", "tempo", "devices", "transport", "transpose"]);
  });

  it("remembers the order under sps_topbar and never touches the panels' sps_panels", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("loop", "transport");
    expect(JSON.parse(localStorage.getItem("sps_topbar") ?? "null").order[0]).toBe("loop");
    expect(localStorage.getItem("sps_panels")).toBeNull();
    const again = (await fresh()).useTopbarOrder;
    expect(again.getState().order[0]).toBe("loop");
  });

  it("is not changed by moving the panels under the stems", async () => {
    const { useTopbarOrder } = await fresh();
    const { useAnalyzerPanels } = await import("./panels");
    useAnalyzerPanels.getState().move("takes", "roll");
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose", "chords"]);
    expect(localStorage.getItem("sps_topbar")).toBeNull();
  });

  it("puts the cards back in their usual order", async () => {
    const { useTopbarOrder } = await fresh();
    useTopbarOrder.getState().move("chords", "transport");
    useTopbarOrder.getState().resetOrder();
    expect(useTopbarOrder.getState().order).toEqual(["transport", "loop", "tempo", "devices", "transpose", "chords"]);
  });

  it("keeps an order saved before Transpose and Chords were two cards: the old card is dropped, the new ones slot in after the card that precedes them by default", async () => {
    localStorage.setItem("sps_topbar", JSON.stringify({ overrides: {}, order: ["keys", "devices", "transport", "loop", "tempo"] }));
    const { useTopbarOrder } = await fresh();
    expect(useTopbarOrder.getState().order).toEqual(["devices", "transpose", "chords", "transport", "loop", "tempo"]);
  });
});
