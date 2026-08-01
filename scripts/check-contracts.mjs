#!/usr/bin/env node
/**
 * The three contracts that fail SILENTLY.
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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DIST = "dist";
const REACT_SPECIFIERS = [
  "react",
  "react-dom",
  "react/jsx-runtime",
  "react/jsx-dev-runtime",
  "react-dom/client",
];

const failures = [];
const notes = [];

const manifest = JSON.parse(readFileSync("objectiveai.json", "utf8"));
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

for (const n of notes) console.log(`  ok  ${n}`);
if (failures.length) {
  console.error("\ncontract check FAILED:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log("\nall contracts hold.");
