#!/usr/bin/env node
// Generates src/lib/ipc.generated.ts from the #[tauri::command] functions in
// src-tauri/src, so a command's TypeScript wrapper is never written by hand.
//
//   node scripts/gen-ipc.mjs            write src/lib/ipc.generated.ts
//   node scripts/gen-ipc.mjs --check    exit 1 when the committed file is stale
//   node scripts/gen-ipc.mjs --list     print the parsed commands as JSON
//
// What a Rust signature cannot say (struct names, serde_json::Value returns,
// narrower TS types, defaults, legacy wrapper names, commands wrapped by
// @giamat90/mps-core) lives in scripts/ipc-types.json. Anything the generator
// cannot map is an error, never a silent `any`.
//
// This file is identical in VPS and SPS; keep the two in step.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rustDir = join(root, "src-tauri", "src");
const configPath = join(root, "scripts", "ipc-types.json");
const outPath = join(root, "src", "lib", "ipc.generated.ts");

const INJECTED = /^(AppHandle|tauri::AppHandle|State<|tauri::State|WebviewWindow|tauri::WebviewWindow|Window\b|tauri::Window|Webview\b)/;
const NUMBERS = new Set(["i8", "i16", "i32", "i64", "isize", "u8", "u16", "u32", "u64", "usize", "f32", "f64"]);

const fail = (msg) => {
  console.error(`gen-ipc: ${msg}`);
  process.exit(1);
};

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
const read = (p) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");

function rustFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "<" || ch === "(" || ch === "[") depth++;
    if (ch === ">" || ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// A Rust type as a tree: { name, args } with the module path dropped.
function parseType(raw, where) {
  let s = raw.trim().replace(/^&\s*('\w+\s+)?(mut\s+)?/, "");
  if (s === "()") return { name: "()", args: [] };
  const m = s.match(/^([\w:]+)\s*(?:<([\s\S]*)>)?$/);
  if (!m) fail(`${where}: cannot parse the type "${raw}"`);
  const name = m[1].split("::").pop();
  const args = m[2] === undefined ? [] : splitTopLevel(m[2]).map((a) => parseType(a, where));
  return { name, args };
}

function toTs(t, config, where) {
  const { name, args } = t;
  if (name === "()") return "void";
  if (name === "String" || name === "str" || name === "PathBuf") return "string";
  if (name === "bool") return "boolean";
  if (NUMBERS.has(name)) return "number";
  if (name === "Value") return "unknown";
  if (name === "Option") return `${toTs(args[0], config, where)} | null`;
  if (name === "Vec") {
    if (args[0].name === "u8") return "number[]";
    const inner = toTs(args[0], config, where);
    return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
  }
  if (name === "HashMap" || name === "BTreeMap") return `Record<string, ${toTs(args[1], config, where)}>`;
  const mapped = config.types?.[name];
  if (mapped) return mapped;
  fail(`${where}: no TypeScript type for the Rust type "${name}". Add it to "types" in scripts/ipc-types.json.`);
}

function parseCommands(config) {
  const commands = [];
  for (const file of rustFiles(rustDir)) {
    const src = read(file);
    const lines = src.split("\n");
    const re = /#\[tauri::command\]/g;
    let m;
    while ((m = re.exec(src))) {
      const line = src.slice(0, m.index).split("\n").length - 1;
      const doc = [];
      for (let i = line - 1; i >= 0; i--) {
        const l = lines[i].trim();
        if (l.startsWith("///")) doc.unshift(l.replace(/^\/\/\/ ?/, ""));
        else if (l.startsWith("#[")) continue;
        else break;
      }
      const rest = src.slice(m.index + m[0].length);
      const sig = rest.match(/^\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\(/);
      if (!sig) fail(`${file}:${line + 1}: cannot read the function after #[tauri::command]`);
      const name = sig[1];
      const where = `${name} (${file.slice(root.length + 1).replace(/\\/g, "/")})`;
      let i = sig[0].length;
      let depth = 1;
      const start = i;
      while (depth > 0 && i < rest.length) {
        const ch = rest[i++];
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      const paramText = rest.slice(start, i - 1);
      const ret = rest.slice(i).match(/^\s*->\s*([\s\S]*?)\s*\{/);
      if (!ret) fail(`${where}: expected "-> Result<T, String>"`);
      const skipped = Boolean(config.skip?.[name]);
      const retType = parseType(ret[1], where);
      if (retType.name !== "Result" || retType.args.length !== 2) fail(`${where}: a command must return Result<T, String>`);

      const params = [];
      for (const raw of splitTopLevel(paramText)) {
        const p = raw.match(/^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/);
        if (!p) fail(`${where}: cannot read the parameter "${raw}"`);
        if (INJECTED.test(p[2].trim())) continue;
        const type = parseType(p[2], where);
        const optional = type.name === "Option";
        const inner = optional ? type.args[0] : type;
        const key = camel(p[1]);
        const override = config.params?.[`${name}.${key}`];
        params.push({
          name: key,
          optional,
          ts: skipped ? "unknown" : override ?? toTs(inner, config, where),
          def: config.defaults?.[`${name}.${key}`],
        });
      }
      const returnsOverride = config.returns?.[name];
      commands.push({
        name,
        module: file.slice(rustDir.length + 1).replace(/\\/g, "/").replace(/\.rs$/, ""),
        doc,
        params,
        returns: skipped ? "unknown" : returnsOverride ?? toTs(retType.args[0], config, where),
        skipped,
      });
    }
  }
  return commands;
}

function jsdoc(doc) {
  if (doc.length === 0) return "";
  const text = doc.map((l) => l.trimEnd());
  if (text.length === 1) return `/** ${text[0]} */\n`;
  return `/**\n${text.map((l) => (l ? ` * ${l}` : " *")).join("\n")}\n */\n`;
}

function emit(commands, config) {
  const unknownSkips = Object.keys(config.skip ?? {}).filter((s) => !commands.some((c) => c.name === s));
  if (unknownSkips.length) fail(`"skip" names commands that do not exist: ${unknownSkips.join(", ")}`);
  const unknownNames = Object.keys(config.names ?? {}).filter((s) => !commands.some((c) => c.name === s));
  if (unknownNames.length) fail(`"names" names commands that do not exist: ${unknownNames.join(", ")}`);

  const body = [];
  const seen = new Set();
  for (const c of commands) {
    if (c.skipped) continue;
    const fn = config.names?.[c.name] ?? camel(c.name);
    if (seen.has(fn)) fail(`two commands produce the wrapper name "${fn}"`);
    seen.add(fn);
    const params = c.params.map((p, i) => {
      const tail = c.params.slice(i + 1).every((q) => q.optional);
      if (p.def !== undefined) return `${p.name} = ${p.def}`;
      if (p.optional) return `${p.name}${tail ? "?" : ""}: ${p.ts} | null`;
      return `${p.name}: ${p.ts}`;
    });
    const payload = c.params.map((p) => (p.optional && p.def === undefined ? `${p.name}: ${p.name} ?? null` : p.name));
    const head = `export async function ${fn}(${params.join(", ")}): Promise<${c.returns}> {`;
    const signature = head.length > 110
      ? `export async function ${fn}(\n${params.map((p) => `  ${p},`).join("\n")}\n): Promise<${c.returns}> {`
      : head;
    const call = payload.length
      ? `invoke<${c.returns}>("${c.name}", { ${payload.join(", ")} })`
      : `invoke<${c.returns}>("${c.name}")`;
    body.push(`${jsdoc(c.doc)}${signature}\n  return ${call};\n}\n`);
  }

  const text = body.join("\n");
  const imports = Object.entries(config.imports ?? {})
    .map(([from, names]) => [from, names.filter((n) => new RegExp(`\\b${n}\\b`).test(text))])
    .filter(([, names]) => names.length)
    .map(([from, names]) => `import type { ${names.join(", ")} } from "${from}";`);

  return [
    "// GENERATED by scripts/gen-ipc.mjs from the #[tauri::command] functions in src-tauri/src. Do not edit.",
    "// Add a command: write the Rust fn, register it in lib.rs, run `npm run gen:ipc`.",
    'import { invoke } from "@tauri-apps/api/core";',
    ...imports,
    "",
    text,
  ].join("\n");
}

if (!existsSync(configPath)) fail(`missing ${configPath}`);
const config = JSON.parse(read(configPath));
const commands = parseCommands(config);
const arg = process.argv[2];

if (arg === "--list") {
  console.log(JSON.stringify(commands.map(({ name, module, params, skipped }) => ({ name, module, skipped, params: params.map(({ name: n, optional, def }) => ({ name: n, optional: optional || def !== undefined })) })), null, 2));
} else {
  const output = emit(commands, config);
  if (arg === "--check") {
    const current = existsSync(outPath) ? read(outPath) : "";
    if (current !== output) {
      console.error("gen-ipc: src/lib/ipc.generated.ts is stale. Run `npm run gen:ipc` and commit the result.");
      process.exit(1);
    }
  } else {
    writeFileSync(outPath, output);
    console.log(`gen-ipc: wrote ${outPath.slice(root.length + 1)} (${commands.filter((c) => !c.skipped).length} wrappers, ${commands.filter((c) => c.skipped).length} skipped)`);
  }
}
