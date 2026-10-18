// Cross-language contract. The TypeScript command wrappers are generated from the
// Rust #[tauri::command] signatures (scripts/gen-ipc.mjs -> src/lib/ipc.generated.ts),
// except the lyrics and YouTube sign-in wrappers that ship in @giamat90/mps-core.
// What can still drift is checked here: the committed file is current, every
// command is registered in lib.rs, and the mps-core wrappers still match their
// Rust handlers.

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");
const generator = (...args: string[]) =>
  execFileSync(process.execPath, [join(root, "scripts", "gen-ipc.mjs"), ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

interface RustCommand { name: string; module: string; skipped: boolean; params: { name: string; optional: boolean }[] }

const commands: RustCommand[] = JSON.parse(generator("--list"));
const byName = new Map(commands.map((c) => [c.name, c]));
const libRs = read("src-tauri/src/lib.rs");
const config = JSON.parse(read("scripts/ipc-types.json")) as { skip: Record<string, string> };

const generated = read("src/lib/ipc.generated.ts");
const coreWrappers = read("node_modules/@giamat90/mps-core/src/lyrics/ipc.ts") + "\n" + read("node_modules/@giamat90/mps-core/src/youtube/ipc.ts");

interface TsInvoke { wrapper: string; command: string; keys: string[] }

function tsInvokes(text: string): TsInvoke[] {
  const out: TsInvoke[] = [];
  const re = /export async function (\w+)[\s\S]*?\{\s*return invoke(?:<[^(]*>)?\(\s*"(\w+)"(?:,\s*\{([^}]*)\})?\s*\)/g;
  for (const m of text.matchAll(re)) {
    const keys = (m[3] ?? "").split(",").map((k) => k.trim().split(":")[0].trim()).filter(Boolean);
    out.push({ wrapper: m[1], command: m[2], keys });
  }
  return out;
}

describe("generated IPC wrappers", () => {
  it("parses a plausible number of commands (guards the parser itself)", () => {
    expect(commands.length).toBeGreaterThanOrEqual(25);
  });

  it("src/lib/ipc.generated.ts is current: run `npm run gen:ipc` after changing a command", () => {
    expect(() => generator("--check")).not.toThrow();
  });

  it("generates a wrapper for every command that is not wrapped by mps-core", () => {
    const wrapped = new Set(tsInvokes(generated).map((i) => i.command));
    const missing = commands.filter((c) => !c.skipped && !wrapped.has(c.name)).map((c) => c.name);
    expect(missing).toEqual([]);
  });
});

describe("lib.rs registration", () => {
  const block = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const registered = new Set([...block.matchAll(/\b\w+::(\w+)\s*,/g)].map((m) => m[1]));

  it("registers every #[tauri::command] in generate_handler!", () => {
    const missing = commands.filter((c) => !registered.has(c.name)).map((c) => `${c.module}::${c.name}`);
    expect(missing, "add these to generate_handler! in src-tauri/src/lib.rs").toEqual([]);
  });

  it("does not register commands that do not exist", () => {
    expect([...registered].filter((n) => !byName.has(n))).toEqual([]);
  });

  it("registers each command under the module that defines it", () => {
    const wrong = commands.filter((c) => !block.includes(`${c.module}::${c.name}`)).map((c) => `${c.module}::${c.name}`);
    expect(wrong).toEqual([]);
  });
});

describe("wrappers agree with the Rust arguments", () => {
  const invokes = [...tsInvokes(generated), ...tsInvokes(coreWrappers)];

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s calls a Rust command", (_w, inv) => {
    expect(byName.has(inv.command), `no Rust command "${inv.command}"`).toBe(true);
  });

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s sends only keys the Rust command accepts", (_w, inv) => {
    const accepted = new Set((byName.get(inv.command)?.params ?? []).map((p) => p.name));
    const unknown = inv.keys.filter((k) => !accepted.has(k));
    expect(unknown, `${inv.command} does not take: ${unknown.join(", ")}`).toEqual([]);
  });

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s supplies every required Rust argument", (_w, inv) => {
    const missing = (byName.get(inv.command)?.params ?? []).filter((p) => !p.optional && !inv.keys.includes(p.name)).map((p) => p.name);
    expect(missing, `${inv.command} requires: ${missing.join(", ")}`).toEqual([]);
  });

  it("every Rust command is reachable from a generated or mps-core wrapper", () => {
    const used = new Set(invokes.map((i) => i.command));
    expect(commands.filter((c) => !used.has(c.name)).map((c) => c.name)).toEqual([]);
  });

  it("each command the generator skips really is wrapped by mps-core", () => {
    const core = new Set(tsInvokes(coreWrappers).map((i) => i.command));
    const stray = Object.keys(config.skip).filter((n) => !core.has(n));
    expect(stray, "remove from \"skip\" in scripts/ipc-types.json, or restore the mps-core wrapper").toEqual([]);
  });
});

describe("YouTube sign-in", () => {
  it("the invoke handler keeps the sign-in window away from the app's commands", () => {
    expect(libRs).toMatch(/mps_youtube_signin::may_invoke\(/);
  });

  it("the main window's teardown closes the sign-in window too", () => {
    expect(read("src-tauri/src/windows.rs")).toMatch(/mps_youtube_signin::close\(/);
  });
});
