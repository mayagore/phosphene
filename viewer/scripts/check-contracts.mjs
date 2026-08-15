#!/usr/bin/env node
/**
 * The six contracts that fail SILENTLY.
 *
 * Run after `pnpm run build`, in CI and before any release. Each check exists
 * because the failure it catches produced a real, hard-to-diagnose bug — two of
 * them upstream in ObjectiveAI itself (see docs/spikes/00-boot-check.md).
 *
 *   1. React external. The host serves ONE React instance through the import
 *      map in its `tab.html`; a tab bundle carrying its own copy dies on the
 *      first hook. `objectiveai-laboratory/src/viewer_build.rs` says outright
 *      this is "the ONE invariant we cannot enforce" — so it is ours.
 *   2. Declared paths exist. Every `module`, `styles` entry, `scripts[].module`
 *      and `icon` in the manifest must be a real file in the output, or the
 *      release build fails and development 404s.
 *   3. Entry exports survive. A module whose exports get stripped renders as a
 *      blank tab with NO error — the host's bootstrap does
 *      `typeof component !== "function" -> return`. This is exactly the bug
 *      that made every ObjectiveAI ≤2.2.14 viewer unable to render any plugin.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKit } from "./gen-fontkit.mjs";

// Resolved from THIS FILE, not the cwd. The scaffold layout puts the one
// manifest at the repo root and the viewer half in `viewer/`, so the two live
// at different depths — and CI runs this from the root while `pnpm run
// check:contracts` runs it from `viewer/`.
const HERE = dirname(fileURLToPath(import.meta.url)); // viewer/scripts
const VIEWER = resolvePath(HERE, "..");
const ROOT = resolvePath(VIEWER, "..");
const MANIFEST = join(ROOT, "objectiveai.json");
const DIST = join(VIEWER, "dist");
const REACT_SPECIFIERS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
];

const failures = [];
const notes = [];

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const viewer = manifest.viewer;
if (!viewer) {
  failures.push("objectiveai.json declares no `viewer` half");
}

/** Manifest paths are relative to the built output ("./x.js" -> dist/x.js). */
const resolve = (p) => join(DIST, p.replace(/^\.?\//, ""));

// ── 2. Every declared path exists ────────────────────────────────────────
const declared = [];
for (const tab of viewer?.tabs ?? []) {
  declared.push(["tab module", tab.module]);
  for (const style of tab.styles ?? []) declared.push(["tab style", style]);
}
for (const script of viewer?.scripts ?? []) {
  declared.push(["script module", script.module]);
}
if (viewer?.icon) declared.push(["icon", viewer.icon]);

for (const [kind, path] of declared) {
  if (!existsSync(resolve(path))) {
    failures.push(`${kind} declared but missing from ${DIST}/: ${path}`);
  }
}
notes.push(`${declared.length} declared path(s) checked`);

// ── 1 & 3. Per tab module: React external, and exports survive ───────────
const tabModules = (viewer?.tabs ?? []).map((t) => t.module);
for (const path of tabModules) {
  const file = resolve(path);
  if (!existsSync(file)) continue; // already reported above
  const src = readFileSync(file, "utf8");

  // 1. React must be imported as a BARE specifier, never inlined.
  const bare = new Set(
    [...src.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]),
  );
  const usedReact = REACT_SPECIFIERS.filter((s) => bare.has(s));
  if (usedReact.length === 0) {
    failures.push(
      `${path}: no bare react import found — react may have been bundled in ` +
        `(a tab bundle MUST leave react external)`,
    );
  }
  // A bundled React drags its internals in; the bare specifiers never would.
  for (const canary of ["__CLIENT_INTERNALS_DO_NOT_USE", "__SECRET_INTERNALS"]) {
    if (src.includes(canary)) {
      failures.push(`${path}: bundled React detected (found ${canary})`);
    }
  }

  // 3. The export the manifest dereferences must actually be emitted.
  const wanted =
    (viewer.tabs.find((t) => t.module === path) ?? {}).export ?? "default";
  const exportBlock = /export\s*\{[\s\S]*?\}\s*;?\s*$/m.exec(src);
  const exportsIt =
    exportBlock &&
    new RegExp(`\\b(as\\s+)?${wanted}\\b`).test(exportBlock[0]);
  if (!exportsIt) {
    failures.push(
      `${path}: no \`${wanted}\` export in the built module — the host would ` +
        `render a BLANK TAB with no error`,
    );
  }
  notes.push(
    `${path}: react external (${usedReact.join(", ") || "none"}), exports \`${wanted}\``,
  );
}

// ── 4. The manifest declares what we INTEND ──────────────────────────────
// The checks above are one-directional: they assert everything declared
// exists. Nothing asserted the manifest declares anything at all. Renaming
// `tabs` to `tab` produced a viewer half with zero boot tabs and a clean
// "all contracts hold, exit 0".
const tabs = viewer?.tabs ?? [];
const bootTabs = tabs.filter((t) => typeof t.title === "string");
if (bootTabs.length < 1) {
  failures.push(
    "manifest declares no boot tab (a `viewer.tabs[]` entry with a `title`) — " +
      "the plugin would install and surface nothing",
  );
}
for (const t of tabs) {
  // ViewerTab is an UNTAGGED enum: an entry carrying BOTH reads as a channel
  // handler and its title is silently ignored, so it never opens at boot.
  if (t.title !== undefined && t.channel_key !== undefined) {
    failures.push(
      `tab declares both \`title\` and \`channel_key\` (${t.module}) — reads as a ` +
        `channel handler, never boots`,
    );
  }
  if (t.title === undefined && t.channel_key === undefined) {
    failures.push(`tab declares neither \`title\` nor \`channel_key\`: ${t.module}`);
  }
}
notes.push(`${bootTabs.length} boot tab(s), ${tabs.length - bootTabs.length} channel handler(s)`);

// ── 5. The built CSS actually APPLIES ────────────────────────────────────
// Shipped once with the whole token file inside a Tailwind-only `@theme{}`
// block in a build with no Tailwind: the engine discards the at-rule and
// every declaration in it, so all 73 tokens were inert and all 25 var()
// references resolved to nothing. Every other check passed.
const KNOWN_AT_RULES = new Set([
  "media", "supports", "keyframes", "font-face", "import", "charset",
  "layer", "container", "page", "property", "scope", "starting-style",
  "counter-style", "namespace", "font-feature-values",
]);
for (const [, path] of declared.filter(([k]) => k === "tab style")) {
  const file = resolve(path);
  if (!existsSync(file)) continue;
  const css = readFileSync(file, "utf8");

  for (const m of css.matchAll(/@([a-zA-Z-]+)/g)) {
    if (!KNOWN_AT_RULES.has(m[1])) {
      failures.push(
        `${path}: unknown at-rule @${m[1]} — browsers discard the rule AND ` +
          `every declaration inside it (this is how @theme shipped inert)`,
      );
    }
  }

  const used = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const undef = [...used].filter((v) => !defined.has(v));
  if (undef.length) {
    failures.push(
      `${path}: ${undef.length} var() reference(s) not defined in this sheet — ` +
        `they resolve to nothing, or worse, to the HOST's same-named token: ` +
        undef.slice(0, 6).join(", "),
    );
  }
  notes.push(`${path}: ${used.size} var() refs, all defined; no unknown at-rules`);
}

// ── 6. The viewer's font kit IS the MCP kit ──────────────────────────────
// Boards travel lean (payloads elided) and the viewer re-attaches the kit at
// display time. A stale copy fails SILENTLY: the family name matches, the
// bytes differ — or a new face never reaches the viewer and its boards
// render in fallback type forever. Compare the generated module against the
// source of truth (mcp/src/fonts.rs + mcp/fonts/*.woff2) by name, weight
// and hash.
{
  const FONTS_RS = join(ROOT, "mcp", "src", "fonts.rs");
  const FONTS_DIR = join(ROOT, "mcp", "fonts");
  const GENERATED = join(VIEWER, "src", "lib", "fontkit.generated.ts");
  if (!existsSync(GENERATED)) {
    failures.push("src/lib/fontkit.generated.ts missing — run scripts/gen-fontkit.mjs");
  } else {
    const wanted = [];
    for (const face of parseKit(readFileSync(FONTS_RS, "utf8"))) {
      for (const { weight, file } of face.weights) {
        const bytes = readFileSync(join(FONTS_DIR, file));
        wanted.push(
          `${face.family}/${weight}/${createHash("sha256").update(bytes).digest("hex")}`,
        );
      }
    }
    const generated = readFileSync(GENERATED, "utf8");
    const have = [...generated.matchAll(
      /family:\s*"([^"]+)",\s*weight:\s*(\d+),\s*file:\s*"[^"]+",\s*sha256:\s*"([0-9a-f]{64})"/g,
    )].map((m) => `${m[1]}/${m[2]}/${m[3]}`);
    const missing = wanted.filter((w) => !have.includes(w));
    const extra = have.filter((h) => !wanted.includes(h));
    if (missing.length || extra.length) {
      failures.push(
        `fontkit.generated.ts is STALE (missing ${missing.length}, extra ${extra.length} ` +
          `face-weight(s)) — run scripts/gen-fontkit.mjs and commit the result`,
      );
    } else {
      notes.push(`font kit: ${have.length} face-weight(s) match mcp/fonts by name, weight, hash`);
    }
  }
}

for (const n of notes) console.log(`  ok  ${n}`);
if (failures.length) {
  console.error("\ncontract check FAILED:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nall contracts hold.");
