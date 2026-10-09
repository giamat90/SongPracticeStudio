// Cross-language contract: the TypeScript IPC wrappers (src/lib/tauri.ts) and
// the Rust command handlers (src-tauri/src) are only linked by strings at
// runtime. A renamed command or argument fails silently (Tauri rejects the call
// or passes None), so this test reads both sources and checks they agree.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8").replace(/\r\n/g, "\n");

const tauriTs = read("src/lib/tauri.ts");
const commandsRs = read("src-tauri/src/commands.rs");
const libRs = read("src-tauri/src/lib.rs");

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

interface RustParam { name: string; optional: boolean }

function rustCommands(): Map<string, RustParam[]> {
  const out = new Map<string, RustParam[]>();
  const re = /#\[tauri::command\]\s*pub (?:async )?fn (\w+)\(([\s\S]*?)\)\s*->/g;
  for (const m of commandsRs.matchAll(re)) {
    const params: RustParam[] = [];
    // Split on top-level commas only: types like State<'_, SidecarState> contain commas.
    let depth = 0;
    let current = "";
    const chunks: string[] = [];
    for (const ch of m[2]) {
      if (ch === "<" || ch === "(") depth++;
      if (ch === ">" || ch === ")") depth--;
      if (ch === "," && depth === 0) { chunks.push(current); current = ""; } else current += ch;
    }
    chunks.push(current);
    for (const raw of chunks) {
      const p = raw.trim().match(/^(\w+)\s*:\s*([\s\S]+)$/);
      if (!p) continue;
      const [, name, type] = p;
      if (type.startsWith("AppHandle") || type.startsWith("State<") || type.startsWith("tauri::State")) continue;
      params.push({ name: camel(name), optional: type.trim().startsWith("Option<") });
    }
    out.set(m[1], params);
  }
  return out;
}

interface TsInvoke { command: string; keys: string[]; wrapper: string }

function tsInvokes(): TsInvoke[] {
  const out: TsInvoke[] = [];
  const re = /export async function (\w+)[\s\S]*?\{\s*return invoke(?:<[^(]*>)?\(\s*"(\w+)"(?:,\s*\{([^}]*)\})?\s*\)/g;
  for (const m of tauriTs.matchAll(re)) {
    const keys = (m[3] ?? "").split(",").map((k) => k.trim().split(":")[0].trim()).filter(Boolean);
    out.push({ wrapper: m[1], command: m[2], keys });
  }
  return out;
}

describe("IPC contract between src/lib/tauri.ts and src-tauri", () => {
  const rust = rustCommands();
  const handlerBlock = libRs.match(/generate_handler!\[([\s\S]*?)\]/)?.[1] ?? "";
  const registered = new Set([...handlerBlock.matchAll(/commands::(\w+)/g)].map((m) => m[1]));
  const invokes = tsInvokes();

  it("parses a plausible number of commands on both sides (guards the regexes themselves)", () => {
    expect(rust.size).toBeGreaterThanOrEqual(20);
    expect(invokes.length).toBeGreaterThanOrEqual(20);
    expect(registered.size).toBeGreaterThanOrEqual(20);
  });

  it("registers every #[tauri::command] in generate_handler!", () => {
    const missing = [...rust.keys()].filter((c) => !registered.has(c));
    expect(missing).toEqual([]);
  });

  it("does not register commands that do not exist", () => {
    const ghosts = [...registered].filter((c) => !rust.has(c));
    expect(ghosts).toEqual([]);
  });

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s calls a registered command", (_w, inv) => {
    expect(rust.has(inv.command), `no Rust command "${inv.command}"`).toBe(true);
    expect(registered.has(inv.command), `"${inv.command}" is not in generate_handler!`).toBe(true);
  });

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s sends only keys the Rust command accepts", (_w, inv) => {
    const params = rust.get(inv.command) ?? [];
    const accepted = new Set(params.map((p) => p.name));
    const unknown = inv.keys.filter((k) => !accepted.has(k));
    expect(unknown, `${inv.command} does not take: ${unknown.join(", ")}`).toEqual([]);
  });

  it.each(invokes.map((i) => [i.wrapper, i] as const))("%s supplies every required Rust argument", (_w, inv) => {
    const params = rust.get(inv.command) ?? [];
    const missing = params.filter((p) => !p.optional && !inv.keys.includes(p.name)).map((p) => p.name);
    expect(missing, `${inv.command} requires: ${missing.join(", ")}`).toEqual([]);
  });

  it("every Rust command is reachable from some TypeScript wrapper", () => {
    const used = new Set(invokes.map((i) => i.command));
    const unused = [...rust.keys()].filter((c) => !used.has(c));
    expect(unused).toEqual([]);
  });
});
