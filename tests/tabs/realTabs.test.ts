import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildTabScore, loadAlphaTab, readScore } from "../../src/lib/tabScore";

// The real tabs a user brings are copyrighted, so these only run where the
// maintainer keeps a folder of them; nothing is checked in.
const LOCAL = "C:/Workspace/GiaMat90/MPS/GP-and-MIDI-files";
const localTabs = fs.existsSync(LOCAL) ? fs.readdirSync(LOCAL).filter((f: string) => f.endsWith(".gp")) : [];

describe.skipIf(localTabs.length === 0)("real Guitar Pro 8 files (local only)", () => {
  it("reads every file, finds its drums, and plays repeats once per pass", async () => {
    const at = await loadAlphaTab();
    for (const file of localTabs) {
      const bytes = new Uint8Array(fs.readFileSync(path.join(LOCAL, file)));
      const s = readScore(at, bytes);
      const built = buildTabScore(at, s);
      expect(built.bars.length, file).toBeGreaterThanOrEqual(s.masterBars.length);
      expect(built.notes.some((n) => n[3] === "g" || n[3] === "b"), file).toBe(true);
      expect(built.notes.some((n) => n[3] === "d" && (n[2] === 36 || n[2] === 38)), `${file} kick or snare`).toBe(true);
    }
  }, 60_000);
});
