import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function fresh() {
  return import("./panels");
}

describe("analyzer panels", () => {
  it("lists the optional panels in the order the menu shows them", async () => {
    const { ANALYZER_PANELS } = await fresh();
    expect(ANALYZER_PANELS.map((p) => p.id)).toEqual(["roll", "meter", "lyrics", "takes"]);
  });

  it("shows everything by default", async () => {
    const { useAnalyzerPanels } = await fresh();
    expect(useAnalyzerPanels.getState().visible).toEqual({ roll: true, meter: true, lyrics: true, takes: true });
  });

  it("remembers the user's choices under sps_panels", async () => {
    const { useAnalyzerPanels } = await fresh();
    useAnalyzerPanels.getState().toggle("takes");
    expect(JSON.parse(localStorage.getItem("sps_panels") ?? "null")).toEqual({ overrides: { takes: false } });
    const again = (await fresh()).useAnalyzerPanels;
    expect(again.getState().visible.takes).toBe(false);
  });

  it("does not touch the general settings key", async () => {
    const { useAnalyzerPanels } = await fresh();
    useAnalyzerPanels.getState().hideAll();
    expect(localStorage.getItem("sps_settings")).toBeNull();
  });
});
