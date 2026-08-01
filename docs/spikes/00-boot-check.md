# Boot check — the unmodified scaffold in a live viewer

> ## RERUN 2026-08-01 against v2.2.15 — **ALL THREE DEFECTS FIXED, PASSES**
> Fixes shipped in [PR #302](https://github.com/ObjectiveAI/objectiveai/pull/302)
> (merged `649b1d7cf`, released `v2.2.15`). Rerun used a scaffold extracted
> fresh from the `v2.2.15` tag — **not** the hand-patched spike directory — so
> every fix was exercised as shipped.
>
> | Defect | v2.2.14 | v2.2.15 |
> |---|---|---|
> | 1 — scaffold build | `Could not resolve "path"` | ✅ `pnpm run build` clean, all 5 declared paths emitted |
> | 2 — plugin tab render | `SyntaxError: Importing binding name 'jsxs' is not found` | ✅ **`PROBE: home module linked` + `PROBE: ScaffoldHome rendered`** |
> | 3 — plugins tab | `TypeError: 'text/html' is not a valid JavaScript MIME type` | ✅ 0 errors; `tabs/plugins.js` now embedded in the binary |
>
> Defect 2 was verified **positively**, not by absence of errors: a `console.log`
> probe at module scope and in the component body both reached the viewer's log
> inbox via `capture.js`. A stripped export would have rendered `null` silently,
> so "no errors" alone would not have been proof.
>
> **The hot-reload ladder is unchanged** — CSS-only save → 0 re-imports (rung 1);
> `.tsx` save → re-import (rung 3), because the scaffold's `styles()` still
> rewrites every stylesheet on every tabs rebuild. That is a *scaffold build*
> issue, deliberately not part of #302, and it remains phosphene's to solve
> (§"Consequences", item 2 below).
>
> **Spikes A–E are unblocked.**


> **Ran:** 2026-07-31
> **Against:** installed ObjectiveAI **v2.2.14**, verified byte-identical to the
> official `objectiveai-2.2.14-macos-aarch64.zip` release build
> (`sha256 0886f09f…8aeb`). Source read at `e79dadb`, which is **one commit past
> the `v2.2.14` tag** (`c68ff003`) and that commit is scaffold-only.
> **Host:** macOS arm64, node v24.12.0, pnpm 10.33.2. **podman: not installed.**

**Verdict: the scaffold does not reach a rendered tab on the current release.**
Three independent defects, two of them upstream blockers. Everything *around*
the tab — registration, argv, `plugin://` dev serving, file watching,
attribution, reload dispatch — works.

This is what "nobody has ever actually used the scaffolding" looks like in
practice.

---

## What was run

```bash
cp -R objectiveai-viewer-plugin-scaffold  <scratch>/scaffold-spike   # unmodified
pnpm install && pnpm run build
pnpm run dev &                                                      # watch
objectiveai development plugins viewer create \
  --owner mayagore --name scaffold-spike --version v0.1.0 --path <abs>
objectiveai viewer spawn
```

Evidence throughout is the viewer's own log inbox,
`~/.objectiveai/state/default/viewer/viewer-logs/<stamp>.jsonl` — which Pass 2
established is fed by `capture.js` from every webview with no cooperation from
the page.

---

## Defect 1 — the scaffold does not build (blocker, trivial fix)

`pnpm run build` on the **unmodified** scaffold fails:

```
node_modules/@objectiveai/sdk/dist/index.js:10006:30:
ERROR: Could not resolve "path"
```

`BinaryCommandExecutor.execute()` dynamically imports exactly four node
builtins — `child_process`, `os`, `path`, `readline`. `build.mjs`'s `external`
array lists **three of them and omits `path`**. Confirmed exhaustively: those
four are the only dynamic imports in the SDK dist.

The same `node build.mjs` runs in the `Containerfile`, so **the release build is
broken too** — this is not a dev-only issue.

**Fix:** add `"path"` to the externals array in `build.mjs`. One word.

*Deviation taken to proceed:* applied that one-word fix locally. Everything
below is with `"path"` added and nothing else changed.

### After the fix, the build contract verifies

| Check | Result |
|---|---|
| All five manifest-declared paths exist in `dist/` | ✅ `home.js`, `home.css`, `credential.js`, `credential.css`, `capture.js` |
| React left external in tab bundles | ✅ `home.js` has bare `from "react"`, `from "react/jsx-runtime"` |
| No bundled-React canary | ✅ zero matches |
| `capture.js` is a classic IIFE, nothing external, CSS inlined as text | ✅ starts `(() => { var capture_default = ".panel {…` |

**Bundle size, worth noting: `home.js` and `credential.js` are 10.7 MB each** —
the SDK bundled unminified into every tab, once per tab. A two-tab demo plugin
ships 21.5 MB of JS.

---

## Defect 2 — no plugin tab can load on v2.2.14 (blocker, upstream)

The plugin tab booted, fetched its module over `plugin://`, and died:

```
[unhandledrejection] scaffold home: SyntaxError: Importing binding name 'jsxs' is not found.
```

`home.js` imports `{ jsx, jsxs } from "react/jsx-runtime"`. `tab.html`'s import
map points that at `/host/react-jsx-runtime.js`. The shim's **source** at HEAD
looks correct — `export { Fragment, jsx, jsxs } from "react/jsx-runtime"` — and
`jsxs` landed 2026-07-27, an ancestor of the `v2.2.14` tag. So the source is
right and the *build* is wrong.

**Reproduced in isolation.** Building HEAD's `src/host/*.ts` with the viewer's
own rollup input/`entryFileNames` config, react 19.2.8, vite 8:

```js
// dist/host/react-jsx-runtime.js  — the entire file
import{t as e}from"../assets/rolldown-runtime-CbXtAM7H.js";var t=e((e=>{}));e(((e,n)=>{n.exports=t()}))();
```

**It contains no `export` statement at all.** Same for `dist/host/react.js`.

**Root cause:** React 19.2.8 ships `react/jsx-runtime` as **CJS only**
(`module.exports = require('./cjs/…')`, gated on `process.env.NODE_ENV`; no
`.mjs`, no `esm/`). Vite 8 builds with **rolldown**, which converts a
`export … from "<cjs module>"` re-export into a CJS-interop wrapper that assigns
`module.exports` and **drops the static ES named exports**. Enumerating the names
in the source — which `host/react.ts`'s comment says was done precisely to defeat
a related dev-transform problem — does not help, because the whole re-export
collapses.

**Why it was never caught:** in `vite dev` the `hostShims` plugin maps
`/host/react.js` onto the shim source and vite serves it transformed against the
optimized dep, which *does* produce real named exports. So `pnpm tauri dev`
works and the release build does not — and the release build is the only one a
plugin author ever meets.

*Confidence:* the repro is not byte-identical to the viewer's own build (it omits
`@vitejs/plugin-react` and tailwind, and has fewer inputs). But the shipped
v2.2.14 binary produces exactly the predicted runtime error, which is direct
empirical corroboration from the real artifact.

**Consequence for phosphene: this is a hard upstream blocker.** There is no
plugin-side workaround — bundling React instead would give the tab a second React
instance while the host renders the component with its own, which is the
invalid-hook-call failure the contract exists to prevent.

---

## Defect 3 — the `plugins` built-in tab 404s in production (upstream, unrelated)

```
[unhandledrejection] plugins: TypeError: 'text/html' is not a valid JavaScript MIME type.
```

`lib/tabs.ts`'s `ROOT_TABS` declares six root tabs including `plugins`, and
`src/tabs/plugins.tsx` exists — but `vite.config.ts`'s `rollupOptions.input`
lists only nine `tabs/*` entries and **`tabs/plugins` is not among them**. So
`/tabs/plugins.js` is never emitted, the app origin serves `index.html` as the
SPA fallback, and the module import rejects on the MIME type.

The config's own comment at `vite.config.ts:55` is the warning that was missed:
*"an explicit rollup input drops the implicit default — everything must be
listed."*

This one does not block phosphene, but it means **the viewer's own plugin-manager
tab is dead in every release build** — which is likely part of why the plugin
path has gone unexercised.

---

## What does work — verified positives

- **The CLI is current.** `objectiveai 2.2.14`, all binaries installed together
  2026-07-30 18:59, viewer byte-identical to the official release zip.
- **`laboratories spawn` is NOT a prerequisite** for a viewer-only development
  registration, despite being step one of the documented loop in
  `SKILL.md`/`scaffold.sh`. Registration alone auto-started the daemon and
  postgres and succeeded: `{"owner":"mayagore","name":"scaffold-spike",…,"replaced":false}`.
  **podman is not installed on this machine and was never needed** — development
  mode serves from disk with no container, exactly as Pass 3 read it.
- **The argv contract is exactly as Pass 2 predicted:**
  `objectiveai-viewer --development-plugin mayagore/scaffold-spike/v0.1.0=/…/scaffold-spike`
- **`plugin://` dev serving works.** The tab fetched `home.js` and `home.css`
  from the registered working tree — proved by the module parsing far enough to
  fail on an import binding.
- **Watching, attribution and reload dispatch all work** (see the ladder below).
- **Logging works exactly as Pass 2 described** — a plugin tab's failure arrives
  in the viewer's inbox under `source` = the tab's **title** (`scaffold home`),
  with no cooperation from the plugin.

---

## The hot-reload ladder, measured

This was the highest-value open question from Pass 3 §3. Method: the tab's module
import fails on every load, so **a re-import produces a new log entry** — which
distinguishes "remount or reload happened" (rungs 2/3) from "styles swapped in
place" (rung 1).

| Test | dist files rewritten | New log entry? | Rung |
|---|---|---|---|
| Append to `src/home.css` | `home.css`, `credential.css` | **no** | **1 — confirmed.** Styles swapped, nothing remounted. |
| Append a comment to `src/home.tsx` | `home.css`, `credential.css` only | no | *nothing fired* — see below |
| Change a string literal in `src/home.tsx` | `home.js`, `home.css`, `credential.css` | **yes** | **3 — full reload** |

**Two findings.**

**(a) esbuild skips writing byte-identical output.** The comment-only edit
rebuilt, but produced identical bytes, so `home.js` was never rewritten, `notify`
never fired, and no reload happened. Harmless, but it will read as "hot reload is
broken" to anyone probing with a trivial edit — worth knowing before chasing it.

**(b) Rung 2 is unreachable with the scaffold's build as written — the Pass 3
residual risk is real.** `build.mjs`'s `styles()` runs `copyFileSync`
unconditionally on **every** tabs rebuild, rewriting every declared stylesheet
whether or not it changed. So a real `.tsx` save changes `home.js` **and**
`home.css`, both of which this tab consumed — two changed consumed files, so
`css_only` is false and `changed.len() == 1` is false, and the ladder falls to
rung 3's full webview reload. The cheap component-remount rung can never be hit.

**For phosphene:** make the stylesheet copy conditional (skip when content or
mtime is unchanged). That one change is what buys rung 2. It also gets more
valuable as tab count grows, since today one tab's rebuild rewrites *every* tab's
CSS.

---

## Consequences for the plan

1. **§5's remaining spikes A–E are blocked behind Defect 2.** Every one of them
   needs a rendering plugin tab. Nothing further can be measured in-viewer until
   the host shims emit real exports.
2. **Report Defects 1–3 upstream.** This is the "expect to find scaffolding bugs,
   and expect them to be ours to report rather than route around" clause in
   `why-rebuild.md`, landing exactly as predicted. Defect 1 is a one-word fix;
   Defect 3 is a one-line fix; Defect 2 needs an upstream decision (ship the
   shims as hand-written ESM that reads the CJS namespace at runtime, mark react
   external in the host build, or pin vite to a rollup-based version).
3. **Defect 2 is the schedule risk, not a phosphene design problem.** It does not
   touch any §6 decision. But it does mean phosphene cannot render anything in
   the viewer until upstream moves — worth raising with Ronald directly rather
   than waiting.
4. **Pass 4 gains a concrete question:** is there an unreleased fix for the host
   shims on `main` or in flight? Branch `2-2-15` at time of writing is
   laboratory-only, so: no.

---

## Machine state after the check

Torn down: watch build killed, `objectiveai viewer kill` → `{"killed":1}`,
registration deleted → `{"removed":true}` and the registration list is empty, the
160 MB release zip removed.

**Left running:** `objectiveai-daemon` + `objectiveai-db`/postgres, which the
registration auto-started and which were not running beforehand.
`objectiveai daemon kill` returns `{"killed":0}` and they persist — the CLI
auto-ensures the daemon on any invocation, so this is likely by design rather
than a failure. Benign (it is the tool's normal resident state), but noted
because the check started from a fully cold machine.

Nothing was written to `~/phosphene` or the ObjectiveAI monorepo. The spike lives
in the session scratchpad and is disposable.
