// The ONE build, shared by `pnpm run build`, `pnpm run dev` (`--watch`),
// and the Containerfile. Adapted from the v2.2.15 viewer scaffold; the
// deviations are deliberate and documented below.
//
// TABS are ESM with react EXTERNAL — the host viewer renders these
// components and owns the single React instance (served through the import
// map in its `tab.html`); a bundle carrying its own copy dies on the first
// hook. Everything else — the SDK, @tauri-apps/api — bundles in.
//
// STYLES are a separate esbuild pass. A bundler strips `import "./x.css"`
// from a JS entry, so the manifest's `styles` array (which the host injects
// and AWAITS before rendering) is the only path that works — the stylesheet
// has to exist in the output as a real file.
//
// ── Deviation 1: no SCRIPTS pass ──────────────────────────────────────
// The scaffold ships a third esbuild pass for browser-tab scripts (classic
// IIFE, nothing external, CSS inlined as text for CSSOM). Phosphene declares
// no `scripts` yet. Restore it from the scaffold verbatim the day we inject
// anything into a browser tab — that pass has INVERTED externals from the
// tab pass, and conflating the two is a real hazard.
//
// ── Deviation 2: styles are BUNDLED, not copied ───────────────────────
// The scaffold `copyFileSync`s each declared stylesheet. Two reasons that
// does not work here:
//
//   1. It cannot resolve `@import`. Our sheet imports `tokens.css`, and a
//      verbatim copy leaves that import dangling — the file never reaches
//      dist/ and every token resolves to nothing. Caught before first run.
//   2. It rewrites the file on every rebuild regardless of content, bumping
//      its mtime. The viewer's dev watcher then sees >1 changed consumed
//      file on a plain .tsx save and drops to its most expensive reload rung
//      (full webview reload) instead of the cheap component remount —
//      measured in docs/spikes/00-boot-check.md.
//
// esbuild fixes both: it inlines `@import`, and it skips writing output whose
// bytes are unchanged. So a .tsx save touches exactly one file (the JS) and a
// .css save touches exactly one file (the CSS), which is what the viewer's
// two cheap reload rungs require.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const tabs = {
  entryPoints: ["src/phosphene.tsx"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outdir: "dist",
  jsx: "automatic",
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "react-dom/client",
    // The SDK's node-only code paths (spawning a local CLI) sit behind
    // dynamic imports a webview never reaches — leave the builtins
    // unresolved rather than bundling for node. All four are required:
    // omitting `path` alone breaks the build outright.
    "child_process",
    "os",
    "path",
    "readline",
    "node:*",
  ],
};

// Mirrors `viewer.tabs[].styles` in objectiveai.json. Every path declared
// there must exist in the output or the release build fails.
const styles = {
  entryPoints: ["src/phosphene.css"],
  bundle: true,
  outfile: "dist/phosphene.css",
};

if (watch) {
  const [js, css] = await Promise.all([context(tabs), context(styles)]);
  await Promise.all([js.watch(), css.watch()]);
  console.log("watching src/ -> dist/");
} else {
  await Promise.all([build(tabs), build(styles)]);
}
