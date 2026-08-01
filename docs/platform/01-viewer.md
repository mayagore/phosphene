# The ObjectiveAI viewer, from the inside

> **Read at:** `ObjectiveAI/objectiveai` @ `e79dadb3e77a0f9ebb349677c6e0dbf8d6e20983` — 2026-07-30 03:38:56 -0500
> **Pass:** 2 of 4 — the viewer
> **Written:** 2026-07-31

**Sources read in full:** `src-tauri/src/run.rs` (542),
`shell/{protocol,plugins,dev,devwatch,native,model,mailbox,commands,logs}.rs`
(≈3,400), `shell/capture.js` (126), `shell/inventory.rs` (first 200 of 551),
`cef/bridge.rs` (157), `src/tab.tsx` (246), `src/lib/{tabs,tabHarness,viewer-transport,executor}.ts`,
`src/host/react.ts`, `tab.html`, `status.html`, `index.html`, `vite.config.ts`,
`build.sh`, `package.json`, `tauri.conf.json`, `capabilities/default.json`,
`src/app.css` (166), `src/styles.css`, `function-tree/styles/function-tree.css`
(scoping only). **Surface-mapped, not read line by line:**
`cef/runtime.rs` (1,174 — full `pub fn` list enumerated),
`shell/browser.rs` (459 — module doc + prelude). **Not read:**
`shell/{install,channels,command_logs,docking,jsonl,shutdown}.rs`,
`cef/{install,profile,log}.rs`, `daemon_proxy.rs`.

**Currency check:** `origin/HEAD` was still `e79dadb` at time of writing. Branch
`2-2-15` (`ffcb1f2`) is two commits ahead — `objectiveai-daemon/src/command/kill_helpers.rs`,
`objectiveai-laboratory/src/{main.rs,podman/install.rs}` — and touches **no
viewer, scaffold, or plugin file.** This artifact is current.

---

## 1. The shape of the thing

There are no iframes and there is no single-page app. Every OS window is a raw
`tauri::Window` labelled `shell-N` — **none is special**, the boot window is just
the first mint (`run.rs:180-184`, `native.rs:1-8`) — hosting:

| Webview | Label | Entry | Band |
|---|---|---|---|
| Tab strip | `chrome-<window>` | `index.html` | top 40 logical px |
| Status bar | `status-<window>` | `status.html` | bottom 32 logical px |
| One per tab | `tab-<id>` | **`tab.html`** | everything between |

The chrome is two band-sized webviews rather than one full-window document
because anything spanning the content band paints over it — invisible between
two WebView2 surfaces, **fatal over a browser tab**, whose surface is a plain
child window CEF paints itself (`native.rs:10-16`). A plugin tab's viewport is
therefore exactly `window_height − 40 − 32` (`native.rs:106-117`), and `h-screen`
inside it means that band.

Two consequences worth holding onto:

- **Background tabs are parked, not hidden.** They sit at `y = 100_000` logical,
  full size, fully alive and laid out — never `hide()`n, because a hidden
  WebView2 suspends rendering before the document lays out at real bounds
  (`native.rs:18-22`, `native.rs:120-137`). **A backgrounded phosphene tab keeps
  running: its streams, listeners and timers are not shell-throttled.** Whether
  the *webview* throttles rAF offscreen is a separate question source cannot
  answer — see §13.
- **Pop-out is lossless.** Detaching a tab reparents its live webview into a new
  window; the document, JS heap and streams never notice (`commands.rs:471-473`,
  `native.rs:274-286`). A failed reparent self-heals by close-and-recreate, which
  *does* lose state.

The window title follows the active tab as `<identity> - <title>`
(`native.rs:453-463`).

---

## 2. What a plugin tab receives at boot — end to end

`tab.html` loads `src/tab.tsx`, which is a **dumb executor of whatever Rust
says**: no switch, no name table, no resolver (`tab.tsx:1-15`). The sequence:

1. **`tab_self`** returns this webview's own `TabDescriptor` — resolved from the
   webview *label*, so a tab can learn only about itself and never enumerate the
   registry (`commands.rs:268-298`). Shape (`commands.rs:76-94`):

   ```ts
   { identity, module, export?, rootModule?, arguments?, styles?, title }
   ```

2. **Module URL resolution** (`tab.tsx:116-122`): root identity — or the
   `rootModule` flag — resolves against the app origin verbatim; anything else
   goes through `pluginAssetUrl(identity, module)` =
   `convertFileSrc("", "plugin") + identity + path` (`tabs.ts:32-34`).

3. **The module and every declared stylesheet load concurrently**, and the
   component renders only once all have — so there is no flash of unstyled
   content and the styles cost no wall clock beyond the module's own fetch
   (`tab.tsx:124-134`).

4. **The component is `module[descriptor.export ?? "default"]`**, rendered under
   the harness (`tab.tsx:135-140`, `tab.tsx:229-237`).

**What the component actually gets** is thinner than you would guess:

```ts
interface TabComponentProps { arguments?: unknown }        // tabHarness.ts:8-10
interface TabHarness { transport: ViewerTransport | null; zoom: number }  // :13-18
```

That is all. `arguments` is opaque JSON Rust never looks inside
(`model.rs:45-48`); the harness carries the daemon transport and the window's
zoom, read via `useTabHarness()`. Note `arguments` is a reserved binding in
strict mode — destructure as `{ arguments: args }` (`tabHarness.ts:5-7`).

> **A manifest-declared boot tab receives NO arguments.** `TabEntry::kind()`
> hardcodes `key: None, arguments: None` (`inventory.rs:83-94`). Arguments exist
> only for tabs opened programmatically via `tabs_open`. Phosphene's entry tab
> starts from nothing but its own persisted state.

The tab is wrapped in `<div className="flex flex-col h-screen">` by the
bootstrap (`tab.tsx:232`), inside `<React.StrictMode>` and a radix
`TooltipProvider` (`tab.tsx:240-246`). **StrictMode means double-invoked effects
in dev** — phosphene's stream subscriptions must be idempotent.

---

## 3. The `plugin://` origin

`plugin://localhost/{owner}/{name}/{version}/{asset...}` resolves to
`<plugins_root>/{owner}/{name}/{version}/viewer/{asset...}`; Windows and Android
surface it as `http://plugin.localhost/...` (`protocol.rs:1-7`, `tabs.ts:26-31`).

- **`Access-Control-Allow-Origin: *` on every response, 404s included.** A module
  `import()` from the app origin is a CORS-mode GET, and the header is
  load-bearing (`protocol.rs:29-33`).
- The `viewer` sub-root is the **hardcoded constant** `VIEWER_DIR`
  (`objectiveai-sdk-rs/src/cli/plugins/manifest.rs:22`), joined rather than read
  from the manifest, "so the two sides cannot drift into 404ing everything"
  (`protocol.rs:92-100`).
- **Owner and name are lowercased** in the install path; the version segment is
  the v-prefixed git tag byte-for-byte (`protocol.rs:96-99`, `plugins.rs:57-59`,
  `plugins.rs:29-34`).
- Path segments rejecting `\`, `%`, `.`, `..` — "the install tree is plain ASCII
  — an escape is an attack, not a name" (`protocol.rs:11-20`).
- Any miss is a flat 404: unknown plugin, no viewer half, bad path, missing file
  alike (`protocol.rs:47-49`).

Version directories **must** parse as `v` + semver or they are skipped with a
warning; the highest version per `(owner, name)` wins (`plugins.rs:71-84`,
`plugins.rs:117-122`).

---

## 4. The React contract — and the CI assertion it implies

**The import map is in `tab.html`, not `index.html`.** `index.html` is the tab
strip and has no map at all. `tab.html:10-20`:

```json
{ "imports": {
  "react":                 "/host/react.js",
  "react-dom":             "/host/react-dom.js",
  "react-dom/client":      "/host/react-dom-client.js",
  "react/jsx-runtime":     "/host/react-jsx-runtime.js",
  "react/jsx-dev-runtime": "/host/react-jsx-dev-runtime.js"
} }
```

Its own comment: *"Plugin bundles are built with react external; this map binds
their bare specifiers to the host-served shims (ONE React instance). Vite hoists
it above every injected module script in dev and build alike. Host code never
ships bare specifiers, so the map only affects plugin modules."*

The shims are real modules with **enumerated** named exports — `export *` from a
CJS module silently loses names under vite's dev transform (`host/react.ts:1-6`),
and they are emitted as unhashed rollup entries at stable `/host/*.js` URLs
(`vite.config.ts:8-30`, `vite.config.ts:73-77`).

**The version to build against: React `^19.2.4`** (`package.json`). Other pins
that matter: `@tauri-apps/api ^2.10.1`, `tailwindcss ^4.3.0`, `vite ^8.0.1`,
`typescript ^5.9.3`, `vitest ^4.0.18`; the viewer package is `2.2.14`.

### The CI assertion, stated precisely

Nothing upstream enforces this — `objectiveai-laboratory/src/viewer_build.rs`
says outright that the React-external invariant is *"the ONE invariant we cannot
enforce"* — and a bundled React dies at runtime on the first hook. So the check
is ours, and it is now writable exactly:

> For every `tab.module` and every `scripts[].module` in `objectiveai.json`,
> after the build: the emitted **tab** bundle must contain a bare `import` (or
> `export … from`) for each of `react`, `react-dom`, `react-dom/client`,
> `react/jsx-runtime`, `react/jsx-dev-runtime` that it uses, and must contain no
> inlined React runtime. **Scripts are the opposite** — classic IIFE, nothing
> external, CSS inlined as text — so the same assertion must not run on them.

Additionally, mirroring `viewer_build.rs`'s `validate_output`: every declared
`tab.module`, `tab.styles[]`, `scripts[].module`, and `icon` must exist as a file
in the built output.

---

## 5. What the viewer's CSS does to a plugin tab

`tab.tsx:36-37` imports `./function-tree/styles/function-tree.css` and
`./app.css` **into the tab document itself**. So every plugin tab renders inside
a document that already carries them.

`function-tree.css` is entirely scoped to `.ft-container` / `.ft-*` and leaks
nothing. **`app.css` is the one that matters.** It is
`@import "tailwindcss"` plus:

- **A full `@theme` token block** (`app.css:19-65`) — warm near-black ground
  (`--color-ground: #0c0a09`, `-raised`, `-surface`), warm grays
  (`--color-info-*`), a copper spectrum (`--color-copper-dim…bright`), semantic
  colors, `--font-sans: "Geist Variable"`, `--font-mono: "JetBrains Mono
  Variable"`, radii, durations. These are live CSS custom properties a plugin can
  read or override.
- **Two `@font-face` declarations** loading Geist and JetBrains Mono as `woff2`
  from the app origin (`app.css:3-17`). A plugin gets both for free.
- **An `@layer base` block that is doing real work** (`app.css:68-101`):
  - `html { height: 100%; color-scheme: dark }` — **forces dark UA scrollbars and
    form controls.**
  - `body { display: flex; flex-direction: column; color: var(--color-info-bright);
    background: var(--color-ground); font-family: var(--font-sans);
    font-size: 13px; line-height: 1.5 }` — **body is a flex column at 13px.**
  - `* { box-sizing: border-box; padding: 0; margin: 0 }` — a universal reset
    *beyond* Tailwind preflight.
  - `*:focus-visible { outline: 1px solid var(--color-copper-dim) }` — copper
    focus ring on everything.
  - `::selection` tinted copper.
- A `prefers-reduced-motion` block that kills animation with `!important`
  (`app.css:161-166`).

**Also hardcoded in Rust:** the webview background color is
`Color(0x0c, 0x0a, 0x09, 0xff)` — `--color-ground` — painted behind every webview
while its document boots, "so neither window creation nor tab creation ever
flashes white" (`native.rs:36-39`). It is a Rust constant, not a per-plugin
setting. **A light-themed plugin tab will flash near-black on every boot.**

So Spike C's question is answered from source, and it is not the question the
plan asked. Not *"can phosphene have its own visual language?"* — it can; the
`styles` array injects a plugin's own sheet at higher precedence. The real
question is:

> Phosphene inherits a dark copper theme, a 13px Geist body, `color-scheme: dark`,
> a universal margin/padding reset, and a near-black boot flash it cannot change.
> Does it **adopt** that theme (cheapest, most native-looking, and free tokens),
> **extend** it, or **override** it — knowing the boot flash and `color-scheme`
> stay dark regardless?

Note the utility classes actually *present* in the document are only those the
viewer's own Tailwind scan generated. A plugin needs its own Tailwind build,
emitted as a declared `styles` entry — **`import "./x.css"` from a JS entry does
not work**; a bundler strips it and emits the file beside the entry, which is
exactly why the manifest has a `styles` array and the shell injects it
(`tab.tsx:39-49`).

One asymmetry worth knowing: an **invalid stylesheet path in the manifest** is
dropped at scan time and the tab renders unstyled (`plugins.rs:545-551`), but a
**declared path that fails to load at runtime rejects and stops the tab
rendering at all** — *"an unstyled tab is a worse lie than a missing one"*
(`tab.tsx:43-49`). Different stages, opposite policies.

---

## 6. The hot-reload ladder — and the build rule it dictates

Development registrations arrive as **argv at viewer spawn**
(`--development-plugin <owner>/<name>/<version>=<path>`, split at the first `=`)
and are **immutable for the process's life** — a registration change respawns the
viewer, which is the entire propagation mechanism (`dev.rs:1-23`,
`dev.rs:84-131`). While a plugin is registered, **installing and uninstalling it
both error**, so the install tree cannot change underneath it (`dev.rs:12-17`).

The trio is canonicalized as owner/name lowercased-and-trimmed, **version
verbatim** (`dev.rs:46-52`). That is where the `v0.1.0` ≠ `0.1.0` gotcha lives:
the version is never normalized, and a mismatch simply never resolves.

Dev assets are served from `<root>/<viewer.development.output>` — read from the
**live** manifest on every request, and `None` if the manifest declares no
`viewer.development`, because *"registration alone does not invent a layout"*
(`dev.rs:216-229`). Dev responses carry `Cache-Control: no-store`
(`protocol.rs:37-43`).

One recursive watcher per root — watching the **directory**, never individual
files, because editors and bundlers save by atomic rename (`devwatch.rs:5-7`) —
debounced 150 ms (`devwatch.rs:36`). Then, per affected tab:

| Rung | Trigger | Effect | Survives |
|---|---|---|---|
| 1 | **every** changed consumed file ends in `.css` | `dev://styles-changed` → link swap in place | everything; nothing remounts |
| 2 | **exactly one** changed file, and it is the entry module | `dev://module-changed` → cache-busted re-import, component remount | document, transport, mailbox subscriptions. **Component state resets.** |
| 3 | anything else | `webview.reload()` | nothing — reboots like a fresh open |

(`devwatch.rs:206-240`; the JS side at `tab.tsx:106-141` and `tab.tsx:74-95`.)

> **This is a build-configuration constraint, and it is the most actionable
> finding in this pass.** Rung 2 requires `changed.len() == 1`
> (`devwatch.rs:221-223`). A watch build that rewrites *both* the JS bundle and
> the CSS file on every save produces two changed consumed files — never
> `css_only`, never a lone entry — and therefore **always falls to rung 3, a full
> document reload.** A code-split build never reaches rung 2 either, since chunks
> are not the entry. To get the cheap rungs, phosphene's watch build must emit
> **one JS file, and rewrite CSS only when CSS actually changed.**
>
> Files only count if a tab **fetched** them: attribution is recorded by the
> `plugin://` handler per requesting webview (`protocol.rs:76-80`,
> `dev.rs:163-182`). A sourcemap nobody fetched does not spoil the count.

Two more rules:

- **`objectiveai.json` changing triggers an inventory rescan** — tab, title and
  script lists are live (`devwatch.rs:142-144`, `devwatch.rs:244-250`).
- **A changed `scripts[]` module CLOSES every browser tab it was injected into.**
  An executed IIFE cannot be unspliced; *"a closed browser is honest where a
  stale one lies"* (`devwatch.rs:174-182`, `dev.rs:32-35`). The profile survives.

**`build.sh` always passes `--features development`** for the daemon-spawned
binary — install-from-source and the release zips both come through it — while
`pnpm tauri dev` "never runs this script and stays featureless"
(`build.sh`, `--features development` block). So the registration and hot-reload
machinery lives in the **installed** viewer, and the ad-hoc dev viewer is the one
without it. That is the opposite of the usual assumption and it shapes how the §5
boot check must be set up.

---

## 7. The mailbox — a real IPC channel, previously unrecorded

One mailbox per `(parent tab, child key)`, two independent lanes, each with
exactly one legitimate reader (`mailbox.rs:1-32`).

- A tab **names** each tab it spawns (`OpenTab.key`). The parent addresses the
  child by key; the child addresses its parent with no key at all — *"the shell
  knows who spawned it, so a child cannot name (or misname) anyone."*
- `send` **queues unconditionally** — a parent may send the instant it spawns,
  before the child has booted; the child drains it on its first subscribe
  (`mailbox.rs:253-270`).
- `drain` never yields the same item twice (`mailbox.rs:72-78`).
- A blocked `subscribe` wakes on a message, on **peer close**, or on timeout; an
  already-closed peer never blocks (`mailbox.rs:294-335`).
- The mailbox **outlives both tabs** and history survives a child closing and
  being replaced under the same key (`mailbox.rs:160-182`).
- `LANE_CAPACITY = 1024`; past that the oldest are dropped (`mailbox.rs:36-40`).

Commands: `tabs_send` / `tabs_subscribe` / `tabs_list` / `tabs_close_child`
(parent side, keyed) and `tabs_parent_send` / `tabs_parent_subscribe` /
`tabs_parent_list` (child side, no key) — `mailbox.rs:402-490`.

`tabs_close_child` is **the only scoped close in the shell**: `tabs_close` takes a
raw tab id and checks nothing, but a caller has no sanctioned way to learn a
child's id, so resolving through the mailbox index means a tab can only ever
close a tab it spawned (`mailbox.rs:437-445`).

**Yes, this is usable between two phosphene tabs** — with one caveat: `key` is
part of the dedupe kind (`model.rs:38-42`), so two children of the same module
under different keys are genuinely different tabs, while re-opening the same
`(module, export, arguments, key)` **focuses the existing tab rather than
minting a second** (`model.rs:369-377`). To get N sibling tabs of one module,
vary `key` or `arguments`.

---

## 8. Browser tabs, CEF, and the rasterization question

A plugin can open a **real Chromium tab** — `tabs_open` with `url` instead of
`module` (`commands.rs:58-70`, `commands.rs:150-173`). It gets:

- **A declared script injected into every main-frame load**, named — never
  inline. *"The plugin never hands over code to run, only the name of code it
  declared at install time"* (`browser.rs:19-22`).
- **Optional persistent profile** via `state`: present ⇒ cookies, localStorage
  and cache persist on disk under a directory derived from the key plus the
  owning identity; absent ⇒ entirely in-memory (`model.rs:92-100`). Exactly one
  browser may hold a persistent profile at a time — Chromium believes it owns the
  SQLite store exclusively (`browser.rs:15-18`).
- **A token-guarded bridge back to the spawning tab's mailbox.** The injected
  prelude exposes exactly three frozen functions (`browser.rs:169-186`):
  `__objectiveai.send(payload) -> boolean`,
  `__objectiveai.subscribe(timeoutMs?) -> Promise<unknown[]>`,
  `__objectiveai.list(pending?) -> Promise<unknown[]>`.
  The native function is pinned `READONLY | DONTDELETE | DONTENUM` on `window`
  before any page script runs (`bridge.rs:114-155`); the page shares the JS world
  and *can* call it, but without the closure-held 128-bit per-spawn token its
  messages are dropped browser-side (`bridge.rs:24-30`). Rust routes verified
  payloads into `TabMail` via `send_from_child_tab` (`mailbox.rs:188-241`).
- **`BRIDGE_PAYLOAD_CAP = 256 KB`** per message, enforced on both sides of the
  process boundary (`bridge.rs:45-49`).

Costs: CEF is a **~200 MB Chromium download deferred to the first browser tab**,
behind a retryable gate (`browser.rs:9-14`); close is a bounded 5 s
flush-then-close (`browser.rs:33-37`).

### Nothing rasterizes. Confirmed exhaustively.

The complete `crate::cef` public surface is:

```
is_initialized  has_browser  sole_browser_title  is_helper_process
run_helper_and_exit  initialize  shutdown  create_browser  set_bounds
reparent  relayout  hide  raise  browsers_in  focus  set_zoom  navigate  close
```

plus the bridge constants. A case-insensitive grep for
`capture|screenshot|image|pdf|print_to|bitmap|paint|snapshot` across `cef/`
returns **nothing**. The Tauri `invoke_handler` (`run.rs:217-265`) has no capture
command either. **There is no host-provided path from a rendered page to an
image, in Tauri or in CEF.**

> **`shell/capture.js` is a false friend.** It is *console-log* capture — it wraps
> every console method plus uncaught errors and unhandled rejections and forwards
> them to `logs_report`. Nothing to do with screen capture. Judging by filename
> alone would have produced a confidently wrong answer about Spike D.

**Spike D is therefore not "does the host offer rasterization" — that is settled,
no.** It becomes: can a plugin tab rasterize *in-page* (canvas /
`SVGForeignObject` / `OffscreenCanvas`) inside a WebView2 document, and is the
result usable? The 256 KB bridge cap means the browser-tab route cannot carry an
image back regardless.

---

## 9. What a plugin may and may not govern in the strip

Sharper than expected, and it constrains product design:

| Command | Who may call it |
|---|---|
| `tabs_open`, `tab_self`, `tabs_close`, `tabs_close_self`, `tabs_select`, `tabs_move`, `tabs_detach`, the six mailbox commands, `ui_get`/`ui_set`, `logs_report` | any content webview |
| **`tabs_inventory`, `tabs_toggle`, `tabs_reorder`** | **root identity only** |
| `tabs_declare`, `channel_request_declare` | **chrome webviews only** |

`sender_identity` derives the caller's identity from the calling webview through
the model — never from arguments (`commands.rs:99-107`) — and the root-only
checks are explicit: *"a plugin tab's webview has IPC access but must not
enumerate or toggle the shell"* (`commands.rs:558-560`, `commands.rs:602`,
`commands.rs:690`).

**So a plugin cannot put itself in the strip programmatically, cannot read the
inventory, and cannot reorder anything.** Strip presence comes from the manifest
`viewer.tabs` array and nowhere else. What it *can* do is open its own tabs at
runtime, which append to the caller's window.

`validate_module` is the seam that makes caller-supplied paths safe: must start
with `/`, no `://`, no `\`, no `//` prefix, no `..` segment
(`commands.rs:109-123`) — applied to `module`, `icon` and every `styles` entry
(`commands.rs:161-179`). A caller can only ever open code under its own root.

`OpenTab` is `deny_unknown_fields` (`commands.rs:21-71`):
`{ module?, export?, title, arguments?, closable?, icon?, styles?, key?, url?, script?, state? }`
— `module` XOR `url`, and `key` requires a content webview because chrome spawns
no children (`commands.rs:180-188`).

**Tab identity and persistence.** A manifest tab's stable name is its normalized
module path plus `#export` for a non-default export — the manifest carries no
separate name (`plugins.rs:528-536`). Display identity includes the version, but
the **persistence key is version-less** (`owner/name`) so toggle and order state
survive plugin upgrades (`plugins.rs:469-477`, `inventory.rs:16-19`). Regular
tabs dedup on `(module, export)`, first declaration wins including its title;
channel handlers dedup on `channel_key` alone and never open at boot
(`plugins.rs:499-526`).

The **icon** is one manifest-level path (`viewer.icon`), normalized root-relative,
shared by every tab of the plugin and resolved by the chrome through
`identityAssetUrl` (`plugins.rs:478-493`, `tabs.ts:273-292`). An invalid icon path
warns to viewer-logs and becomes `None` rather than failing the tab.

---

## 10. Logging — §7's question, answered and inverted

`CAPTURE_INIT_SCRIPT` (`capture.js`) is attached as an **initialization script to
every webview builder** — chrome and content alike (`native.rs:196`,
`native.rs:297`, `logs.rs:27-28`). It runs at document start, before any page
script, and needs **zero cooperation from the page**, so a webview whose bundle
never boots still reports its own death (`capture.js:1-7`).

**Therefore: a plugin reaches the viewer's log inbox through plain
`console.error`.** The plan's §7 guidance — *"the viewer exposes `logs_report`
… we use it rather than `console.error`"* — is backwards. `console.error` **is**
the API, and it is also the only one that catches boot failures.

Entries are stamped Rust-side and appended as JSONL to
`<dir>/state/<state>/viewer/viewer-logs/<viewer-start>.jsonl`, surviving a crash
(`logs.rs:9-19`). **A content webview reports under its tab's TITLE**, resolved at
receipt (`logs.rs:145-155`) — so phosphene's tab titles are its log source names,
which is a small naming decision with real diagnostic consequence.

Caveats to design around (`capture.js`): messages truncate at **4096 chars**
(`:95`), the pre-IPC buffer caps at **500 entries** and then silently drops
(`:71`), and a machinery denylist filters Tauri's own chatter after a
self-sustaining log storm was observed at *50% CPU / 19 GB RAM / a 25 MB logfile*
(`:16-31`).

---

## 11. What a plugin tab may call, at the Tauri layer

`capabilities/default.json` grants `windows: ["shell-*"]`,
`webviews: ["chrome-*", "tab-*"]`, `permissions: ["core:default"]` — **core
only.** No `fs`, no `http`, no `shell` plugin. Combined with
`withGlobalTauri: false` and `csp: null` (`tauri.conf.json`), a plugin tab's
sanctioned surface is: the viewer's own commands, plus the harness `transport`.

The transport is `{ invoke, channel }`, structurally typed as the SDK's
`ViewerTransport` (`viewer-transport.ts:16-33`), and the viewer's own code builds
its client with `Client.viewer(transport)` (`executor.ts:20-28`). **That is the
pattern phosphene should copy.** Every daemon stream rides the Rust-side
`daemon_*` proxy commands; the webview never holds the daemon address, signature,
or agent identity (`run.rs:1-9`, `run.rs:482-488`) — the direct-fetch model was
abandoned because the webview's per-origin HTTP connection cap starved it.

**Spike E is reframed.** There is no `fs` permission, so client-side persistence
means web-platform storage in the tab webview (untested — the tab is a normal
WebView2 document at the app origin, so `localStorage` plausibly works and is
plausibly *shared* with the chrome and every other tab, which is a hazard as much
as a feature), or the mailbox, or the MCP half. The one thing source *does*
settle: a **browser** tab's `state` key gives real persistent Chromium storage
(`model.rs:92-100`).

---

## 12. Corrections to prior research

The plan's §10 test is that a good pass contradicts something in §3. Six:

1. **"`index.html`'s import map" — wrong file.** `index.html` is the tab strip
   and has no import map. It lives in **`tab.html`**, which the plan's Pass 2
   file list omits entirely, along with `status.html`. The single most
   load-bearing contract for phosphene's build was pointed at the wrong file.

2. **§3's invoke-surface summary was materially incomplete.** The **mailbox is a
   first-class, capable API** (§7) — six commands over 490 lines of
   `shell/mailbox.rs`, with lanes, cursors, blocking subscribes and a CEF bridge.
   §3 listed "`tabs_*`" and moved on. This is a genuine capability phosphene was
   built without any knowledge of.

3. **"Nothing rasterizes" — confirmed, but for a bigger surface than checked, and
   one file nearly disproved it by name.** §3 checked the Tauri invoke handler.
   The full CEF surface is also clean (§8). And `shell/capture.js` is console-log
   capture, not screen capture.

4. **§7's logging guidance is inverted.** `console.error` is the sanctioned path,
   not a fallback to be replaced by `logs_report` (§10).

5. **"The viewer's global CSS bleeds into plugin tabs" understates it.** It is not
   bleed — `tab.tsx` *imports* `app.css` into the tab document deliberately, and
   the `@layer base` block restyles `html`, `body` and `*`, forces
   `color-scheme: dark`, and sets a 13px flex-column body. The boot background
   `#0c0a09` is a Rust constant no plugin can change (§5).

6. **`plugins.rs`'s own module doc is stale.** Lines 14-16 say serving plugin code
   *"is the NEXT stage; until then an opened plugin tab renders empty."*
   `protocol.rs` shipped and works. This repo's prose lags its Rust in the plugin
   path too — the same pattern Pass 1 found in the README. **Treat Rust as
   authoritative; record the disagreement.**

Also confirmed rather than contradicted: `VIEWER_DIR` is hardcoded; `Client.viewer(transport)`
is the executor path; tab bundles leave React external; the `styles` array is the
only working stylesheet path; host `UiState` is only `{ zoom, orientation }` with
no theme.

---

## 13. What this changes for phosphene

Findings, not decisions — §6 owns those.

1. **The tab is a thin, well-defined surface, and it is thinner than the old app
   assumed.** One opaque `arguments` prop, a transport, a zoom number. No theme,
   no router, no host state. A manifest boot tab gets no arguments at all.
   Whatever session state phosphene has, it owns end to end.

2. **The strip is not programmable.** Manifest-declared tabs are the only way in;
   `tabs_inventory`/`toggle`/`reorder` are root-only. Phosphene's tab structure
   is a manifest decision made at build time, not a runtime one.

3. **Open-or-focus dedupes on `(identity, key, arguments, module, export)`.**
   "Open a second review tab" is not free — it needs a distinct `key` or distinct
   `arguments`. This shapes any multi-document design.

4. **The mailbox makes a multi-tab phosphene genuinely viable** — a controller tab
   spawning per-design child tabs, or a real browser tab rendering generated HTML
   and reporting back through `__objectiveai.send`. 1024-message lanes, 256 KB per
   bridge message, blocking subscribes with timeouts. This did not exist in the
   old environment and no design of phosphene has considered it.

5. **Design→image is not a host capability.** No rasterization anywhere. Any
   vision-based review either rasterizes in-page or moves to an MCP half. This is
   now a source-level fact rather than a spike outcome, and it should inform §6.3
   (viewer-only vs. both halves) directly.

6. **The build must be shaped by the hot-reload ladder** — one JS file per save,
   CSS written only when CSS changed — or every save costs a full document
   reload. This is a concrete argument for the scaffold's single-entry esbuild
   `build.mjs` over a code-splitting Vite build, and it is the kind of reason §6.5
   wants written down.

7. **Background tabs stay alive.** Long-running generation in a parked tab is not
   shell-suspended.

---

## 14. Open questions carried forward

**To Pass 3** (`objectiveai-viewer-plugin-scaffold/`, `manifest.rs`, the generated
command tree):

- The exact `Viewer` manifest field semantics — `containerfile`, `output`,
  `development.output`, and how `scripts` differ from `tabs` in the build.
- What the scaffold's `build.mjs` actually emits, and whether it already satisfies
  the one-file rung-2 rule in §6.
- The full generated command surface a viewer plugin can reach through
  `Client.viewer(transport)` — the question that shapes the product most.
- `channel_key` tabs: worth phosphene using, or an unrelated mechanism?

**To the spikes:**

- **Spike C** is now a design question, not a feasibility one: adopt, extend, or
  override the viewer's dark copper theme (§5).
- **Spike D** is reframed: in-page rasterization inside a WebView2 tab, since the
  host offers nothing (§8).
- **Spike E** is reframed: `core:default` only, no `fs`. Does `localStorage` work
  in a tab webview, and is it *shared* across tabs at the app origin — which would
  be a collision hazard between phosphene and the viewer's own tabs (§11).
- **New spike:** does a *parked* (offscreen) webview throttle rAF/timers? The
  shell keeps it alive and laid out (`native.rs:18-22`), but WebView2's own
  occlusion behavior is not something source answers.

**Unresolved, low priority:** `shell/{install,channels}.rs` and `daemon_proxy.rs`
were not read; the channel-offer flow and the install/uninstall gates are
described here only from their callers.
