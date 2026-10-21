// Reads a Guitar Pro file with alphaTab and writes the sidecar's tab score (the one the Tab panel builds).
// Run from the repository root: node --experimental-strip-types sidecar/meter_lab/gp2score.mts <in.gp> <out.json>
// alphaTab comes from SPS_NODE_MODULES (a checkout with `npm install` done; a fresh worktree has none).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const modules = process.env.SPS_NODE_MODULES ?? path.resolve("node_modules");
const at: any = await import(pathToFileURL(path.join(modules, "@coderline/alphatab/dist/alphaTab.core.mjs")).href);
const { buildTabScore } = await import(pathToFileURL(path.resolve("src/lib/tabScore.ts")).href);

const [inp, out] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(inp));
const score = at.importer.ScoreLoader.loadScoreFromBytes(bytes, new at.Settings());
const built = buildTabScore(at, score);
const signatures = score.masterBars.map((m: any) => [m.timeSignatureNumerator, m.timeSignatureDenominator]);
fs.writeFileSync(out, JSON.stringify({ ...built, signatures }));
console.log(path.basename(inp), "bars", built.bars.length, "notes", built.notes.length);
