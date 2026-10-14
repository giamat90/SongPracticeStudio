import { describe, it, expect, beforeEach, vi } from "vitest";

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

async function fresh() {
  return import("./waveforms");
}

const ON = { waveforms: true, bassTab: true, songTab: true, vocals: true, drums: true, bass: true, guitar: true, piano: true, other: true };

describe("waveform visibility store", () => {
  it("shows the area, the bass tab and every stem until the user chooses otherwise", async () => {
    const { useWaveformPanels } = await fresh();
    expect(useWaveformPanels.getState().visible).toEqual(ON);
  });

  it("remembers the choices under sps_waveforms, apart from the other panels", async () => {
    const { useWaveformPanels } = await fresh();
    useWaveformPanels.getState().setVisible("drums", false);
    expect(JSON.parse(localStorage.getItem("sps_waveforms") ?? "null")).toEqual({ overrides: { drums: false } });
    expect(localStorage.getItem("sps_panels")).toBeNull();
    expect((await fresh()).useWaveformPanels.getState().visible.drums).toBe(false);
  });

  it("keeps a stem's choice when the whole area is switched off and on again", async () => {
    const { useWaveformPanels } = await fresh();
    const s = useWaveformPanels.getState();
    s.setVisible("guitar", false);
    s.setVisible("waveforms", false);
    s.setVisible("waveforms", true);
    expect(useWaveformPanels.getState().visible.guitar).toBe(false);
  });

  it("has an entry for every stem name a song can have", async () => {
    const { WAVEFORM_PANELS } = await fresh();
    const ids = WAVEFORM_PANELS.map((p) => p.id as string);
    for (const stem of ["vocals", "drums", "bass", "guitar", "piano", "other"]) expect(ids).toContain(stem);
  });

  it("is not the panel store: nothing here can be moved or detached", async () => {
    const { WAVEFORM_PANELS } = await fresh();
    const { ANALYZER_PANELS } = await import("./panels");
    const ids = new Set<string>(ANALYZER_PANELS.map((p) => p.id));
    expect(WAVEFORM_PANELS.some((p) => ids.has(p.id))).toBe(false);
  });
});

describe("waveformMenuItems", () => {
  it("offers the song's stems, in its order, under the waveforms", async () => {
    const { waveformMenuItems } = await fresh();
    expect(waveformMenuItems(["piano", "vocals"])).toEqual([
      { id: "waveforms", label: "Waveforms", parts: [{ id: "piano", label: "Piano" }, { id: "vocals", label: "Vocals" }] },
      { id: "songTab", label: "Tab" },
    ]);
  });

  it("offers the bass tab only for a song that has a bass", async () => {
    const { waveformMenuItems } = await fresh();
    expect(waveformMenuItems(["vocals"]).map((i) => i.id)).toEqual(["waveforms", "songTab"]);
    expect(waveformMenuItems(["vocals", "bass"]).map((i) => i.id)).toEqual(["waveforms", "bassTab", "songTab"]);
  });
});

describe("hiddenStemTags", () => {
  const stems = ["vocals", "drums"] as const;

  it("says nothing about stems that are on screen, where M and S can be seen", async () => {
    const { hiddenStemTags } = await fresh();
    expect(hiddenStemTags(ON, { stems, muted: { vocals: true }, soloed: "drums" })).toEqual({});
  });

  it("says a hidden stem is muted, or is the one soloed", async () => {
    const { hiddenStemTags } = await fresh();
    const hidden = { ...ON, vocals: false, drums: false };
    expect(hiddenStemTags(hidden, { stems, muted: { vocals: true }, soloed: null })).toEqual({ vocals: "muted" });
    expect(hiddenStemTags(hidden, { stems, muted: { vocals: true }, soloed: "vocals" })).toEqual({ vocals: "solo" });
  });

  it("says nothing when a hidden stem simply plays, or belongs to a stem the song lacks", async () => {
    const { hiddenStemTags } = await fresh();
    const hidden = { ...ON, vocals: false, bass: false };
    expect(hiddenStemTags(hidden, { stems, muted: { bass: true }, soloed: null })).toEqual({});
  });
});
