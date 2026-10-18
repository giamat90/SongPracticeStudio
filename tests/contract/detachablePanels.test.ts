// The set of panels that may be detached is written twice: DETACHABLE_PANELS in
// the frontend and the `PANELS` table in Rust. A panel known to only one
// side would open an empty window or be refused, so the two are compared here.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DETACHABLE_PANELS } from "../../src/windows/protocol";

const root = join(__dirname, "..", "..");
const rust = readFileSync(join(root, "src-tauri/src/windows.rs"), "utf8").replace(/\r\n/g, "\n");

function rustPanels(): string[] {
  const start = rust.indexOf("const PANELS: &[PanelSpec]");
  const end = rust.indexOf("];", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...rust.slice(start, end).matchAll(/id:\s*"(\w+)"/g)].map((m) => m[1]);
}

describe("detachable panels", () => {
  it("are the same in the frontend and in Rust", () => {
    expect(rustPanels().sort()).toEqual([...DETACHABLE_PANELS].sort());
  });

  it("take their window handling from mps-core, which pins the label prefix against its frontend half", () => {
    expect(rust).toContain("mps_detached_windows::");
  });
});
