import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  state: {
    stemVolumes: {} as Record<string, number>,
    mutedStems: {} as Record<string, boolean>,
    soloedStem: null as string | null,
    punchIn: null,
    punchOut: null,
    duration: 100,
    minPxPerSec: 1,
    scrollTime: 0,
    setStemVolume: () => {},
    toggleMute: () => {},
    toggleSolo: () => {},
  },
}));

vi.mock("../../stores/player", () => ({
  usePlayerStore: (sel: (s: unknown) => unknown) => sel(h.state),
}));
vi.mock("../../lib/tauri", () => ({ exportStem: async () => {} }));

// zustand renders the store's initial state under react-dom/server, so what the
// user chose is seeded through storage and the component is imported again.
async function render(name: string, hidden: string[] = []) {
  localStorage.setItem(
    "sps_waveforms",
    JSON.stringify({ overrides: Object.fromEntries(hidden.map((id) => [id, false])) }),
  );
  vi.resetModules();
  const { default: StemTrack } = await import("./StemTrack");
  const song = { id: "s1", title: "Song", directory: "C:/lib/s1", stems: [name] };
  return renderToStaticMarkup(
    createElement(StemTrack, { name, song: song as never, containerRef: () => {} }),
  );
}

beforeEach(() => {
  localStorage.clear();
  h.state.mutedStems = {};
  h.state.soloedStem = null;
});

describe("StemTrack hiding", () => {
  it("is shown, with a hide button, until the user hides it", async () => {
    const html = await render("drums");
    expect(html).toContain('class="stem-track"');
    expect(html).toContain('aria-label="Hide Drums waveform"');
  });

  it("collapses only the stem that was hidden", async () => {
    expect(await render("drums", ["drums"])).toContain("stem-track stem-track--collapsed");
    expect(await render("drums", ["vocals"])).not.toContain("--collapsed");
  });

  it("keeps the container and the controls of a hidden stem in the page, so the audio engine still has it", async () => {
    const html = await render("vocals", ["vocals"]);
    expect(html).toContain("stem-track__wave");
    for (const c of ["stem-track__mute", "stem-track__solo", "stem-track__volume"]) expect(html).toContain(c);
  });

  it("collapses nothing for a name it has no setting for", async () => {
    expect(await render("keys", ["vocals", "drums"])).not.toContain("--collapsed");
  });
});
