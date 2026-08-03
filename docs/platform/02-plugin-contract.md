# The plugin contract

> **Read at:** `ObjectiveAI/objectiveai` @ `e79dadb3e77a0f9ebb349677c6e0dbf8d6e20983` — 2026-07-30 03:38:56 -0500
> **Pass:** 3 of 4 — the plugin contract
> **Written:** 2026-07-31

**Sources read in full:** all of `objectiveai-viewer-plugin-scaffold/` — `README.md`,
`objectiveai.json`, `build.mjs`, `package.json`, `Containerfile`, `rename.sh`,
`.agents/skills/viewer-plugin-development/SKILL.md`, `src/{transport.ts,home.tsx,capture.ts,credential.tsx}`
— plus `scaffold.sh` (193), `objectiveai-sdk-rs/src/cli/plugins/manifest.rs`,
`objectiveai-sdk-js/src/viewer.ts` (237),
`objectiveai-sdk-js/src/{daemon/client.ts,cli/command/executor/index.ts}` (relevant
sections), `objectiveai-plugin-scaffold-rs/objectiveai.json`,
`objectiveai-mcp-plugin-scaffold-rs/src/main.rs` (first 70).
**Surface-enumerated:** the whole `objectiveai-sdk-js/src/cli/command/` tree.
**Not read:** `objectiveai-mcp-plugin-framework-rs/src/` beyond its README,
the MCP scaffold's `Containerfile`/`Cargo.toml`, the generated
`objectiveai-json-schema/cli.plugins.*.json` (the Rust structs are the source
those are generated *from*, and were read instead).

**Currency check:** `origin/HEAD` still `e79dadb`; branch `2-2-15` touches no
scaffold, plugin, or SDK path.

---

## 1. One manifest, two independent halves

`objectiveai.json` at the repo root is **the one schema for the one file**, read
by both the laboratory host (which builds each half's image) and the viewer
(`manifest.rs:1-11`).

```
Manifest { description?, mcp?, viewer? }        // at least one, never neither
```

`validate()` refuses a manifest declaring neither half — and that check is also
"what keeps foreign `objectiveai.json`s out," since every field being optional
would otherwise let an unrelated JSON file parse successfully
(`manifest.rs:56-77`).

**Identity is deliberately not in the manifest.** Owner, name and version come
from the path / git tag; readers lowercase owner and name (`manifest.rs:7-9`).
**Unknown fields are tolerated** by serde default, "so future contract additions
pass through unmodeled until typed" (`manifest.rs:9-11`) — which means a manifest
typo is silent, not an error. Worth a schema check in CI.

Critically: **the same file is the repo's manifest and the installed one —
nothing rewrites it in between, so every path it declares must describe the BUILT
layout** (`manifest.rs:33-36`).

---

## 2. The viewer half, field by field

This answers the questions Pass 2 carried.

```
Viewer { containerfile, output, icon?, tabs?, scripts?, development? }
```

| Field | Meaning |
|---|---|
| `containerfile` | Repo-relative path to the Containerfile. **Its own directory is the build context** — a Containerfile at `viewer/Containerfile` sees `viewer/` as root, and its `COPY` steps carry no `viewer/` prefix (`manifest.rs:226-232`, `manifest.rs:86-92`). |
| `output` | **Absolute path inside the built image** whose *contents* become the installed `viewer/` dir. `/dist` holding `home.js` ⇒ `./home.js`. "Plugins never produce an archive; the host packs one." (`manifest.rs:233-240`) |
| `icon` | One identity icon for the whole plugin, shown beside the identity in the strip (`manifest.rs:241-244`). |
| `tabs` | Declaration order = strip order (`manifest.rs:245-256`). |
| `scripts` | Injectable browser-tab scripts, addressed by name (`manifest.rs:257-261`). |
| `development.output` | **Repo-relative HOST path** — the on-disk stand-in for `output`, where the author's watch build writes. Only read when registered for development (`manifest.rs:286-302`). |

`Viewer::validate` is **lexical only, no filesystem** (`manifest.rs:266-273`).
Only `development.output` is validated at all: non-empty, no leading `/`, forward
slashes, no `.`/`..`/empty components (`manifest.rs:304-336`). **Nothing checks
that `module`, `styles` or `icon` exist** — that is the laboratory's
`validate_output` at build time, and 404s in development.

### The `output` / `development.output` split — the thing that confuses

They are different kinds of path and they differ *between layouts*:

| Layout | Registered dir | `viewer.output` | `viewer.development.output` |
|---|---|---|---|
| Viewer half alone | that dir | `/dist` | `dist` |
| Full plugin (`scaffold.sh`) | the **parent** | `/dist` | `viewer/dist` |

`output` is inside the image and never changes; `development.output` is a host
path resolved against the **registered directory**, which is why it moves. The
watch build still runs inside `viewer/` either way
(scaffold `README.md`, `SKILL.md`). Paths in `tabs`/`scripts`/`styles` resolve
against *the contents* of whichever one is live, so **they never change between
the two layouts** — that is the point of the design.

### Tabs: two variants of one untagged enum

```
ViewerTab = { channel_key, module, export?, styles? }   // a CHANNEL HANDLER
          | { title,       module, export?, styles? }   // a regular BOOT tab
```

Untagged — the present field decides, and **an entry carrying both reads as a
handler with its `title` ignored** (`manifest.rs:369-374`).

- A **regular tab** opens at viewer boot.
- A **channel handler** never opens at boot. It opens when an offer with that key
  is accepted, **with the full offer as its `arguments`**, titled by the offer key
  (`manifest.rs:249-253`).
- Duplicates: same `module` among regular tabs, same `channel_key` among
  handlers — entries after the first are ignored (`manifest.rs:253-256`).

`styles` is worth quoting: *"Declaring them is what makes them checkable: the
build fails if a listed sheet is missing from its output. It is also the only
thing that works — a bundler strips `import "./x.css"` from a JS entry and emits
the file beside it, so nothing would ever request it."* And: **"Scope is the
tab's own document (every tab is its own webview), so a plugin's global CSS
cannot reach another tab or the chrome"** (`manifest.rs:394-410`). That last
sentence closes a question Pass 2 left ajar — a plugin's CSS is contained.

### Scripts: deliberately not shaped like tabs

```
ViewerScript { name, module }
```

No `export` — "the injector evaluates a CLASSIC script, which has no module
record and therefore nothing to name. A tab module is a value provider; a script
is an action." No `styles` — "the page is not ours and `plugin://` does not exist
there, so a stylesheet URL is unreachable (and a strict site's CSP would block it
anyway). A script's CSS must be a string inside its own bundle, applied through
CSSOM." (`manifest.rs:338-356`)

**The bundle must inline everything, React included** — no import map exists in a
foreign page, and `import` is a syntax error in a classic script
(`manifest.rs:352-356`). This is the exact inverse of the tab contract, and
conflating the two is a real hazard.

---

## 3. The build — and the Pass 2 rung-2 verdict

`build.mjs` is 74 lines and is **the one build**, shared by `pnpm run build`,
`pnpm run dev --watch`, and the Containerfile. Two opposite esbuild passes:

| | Tabs | Scripts |
|---|---|---|
| entries | `src/home.tsx`, `src/credential.tsx` | `src/capture.ts` |
| format | `esm` | `iife` |
| external | react ×5, plus `child_process`, `os`, `readline`, `node:*` | **nothing** |
| CSS | copied through as real files | `loader: { ".css": "text" }` |

The node builtins are external because *"the SDK's node-only code paths (spawning
a local CLI) sit behind dynamic imports a webview never reaches — leave the
builtins unresolved rather than bundling for node"* (`build.mjs:26-31`). That is a
non-obvious gotcha nobody would guess.

Everything else bundles **in**: `@objectiveai/sdk`, `@tauri-apps/api`,
`canvas-confetti`. The confetti dependency is deliberate — `home.tsx` says it
exists so that working confetti *proves plugin dependencies resolve from the
plugin's own tree* (`home.tsx:8-11`).

> ### The rung-2 verdict
>
> Pass 2 found that the viewer's cheap hot-reload rung requires **exactly one
> changed consumed file**, and warned that a build rewriting both JS and CSS every
> save would always fall to a full webview reload.
>
> **The scaffold's build passes.** Stylesheets are `copyFileSync`'d, not emitted
> by the JS pass (`build.mjs:56-62`), so a `.tsx` save touches one `.js` and a
> `.css` save touches one `.css`. In watch mode the styles copy is an `onEnd`
> plugin on the tabs context only, and scripts build in a separate context
> (`build.mjs:64-72`).
>
> Two residual risks for phosphene: (a) `copyFileSync` runs on **every** tab
> rebuild, rewriting every CSS file even when only the `.tsx` changed — mtime
> changes, so `notify` fires, so a `.tsx` save may land as `{home.js, home.css,
> credential.css}` and drop to rung 3. Whether it actually does depends on
> whether those CSS files were *consumed* by the tab. (b) Adding a second tab
> entry means a save to one rebuilds both. **This is worth measuring in the boot
> check rather than assuming**, and it is the first concrete thing to look at.

`Containerfile` (23 lines) is `node:22-alpine` + corepack, `pnpm install
--ignore-workspace --no-frozen-lockfile`, then `node build.mjs && cp -r
/build/dist /dist`. Its header gives the exact host reproduction:

```bash
podman build -t scaffold-viewer .
podman create --name sv scaffold-viewer && podman cp sv:/dist/. out/
podman rm sv && podman rmi scaffold-viewer
```

**That is the CI recipe**, verbatim from the source of truth.

---

## 4. Registration and release

`scaffold.sh <rs|rust>` scaffolds into the **current directory** and takes the
plugin name from `basename $PWD` (`scaffold.sh:16-18`, `:56`), refusing anything
outside `^[a-z0-9][a-z0-9-]*$` — because that name becomes the MCP server name,
from which the proxy builds every tool's routing prefix, and that rewrite maps `_`
and `.` to `-`; a mangling directory name is refused rather than silently
normalized (`scaffold.sh:50-64`). It refuses to clobber (`:69-75`), collects every
`SKILL.md` into one `.agents/skills/` (`:123-130`), deletes the halves' own
`objectiveai.json` and `rename.sh` in favour of the root's (`:132-134`), and runs
`git init` (`:166-170`).

**It only emits both halves.** There is no viewer-only mode. A viewer-only plugin
means copying `objectiveai-viewer-plugin-scaffold/` by hand — which the scaffold's
own README explicitly supports, with `development.output: dist`.

The development loop (`SKILL.md`, `scaffold.sh:181-191`):

```bash
objectiveai laboratories spawn
objectiveai development plugins viewer create \
  --owner <owner> --name <name> --version v0.1.0 --path <ABSOLUTE plugin root>
cd viewer && pnpm install && pnpm run dev
```

Rules that will bite, all confirmed against Pass 2's Rust reading:

- **Register the directory holding `objectiveai.json`** — the plugin root, not the
  half.
- **Registration respawns a running viewer** (registrations are frozen per viewer
  process).
- **A dev plugin replaces any installed plugin of the same owner/name**, and
  install/uninstall of it are refused while registered.
- **Both halves must register under the same trio AND the same `--path`**, byte
  for byte, "or channel offers will not route to this repo's handler."
- Release = one repo carrying both halves under one `objectiveai.json`, tagged
  `v<semver>`.

---

## 5. What a viewer plugin can actually call

This was billed as the question that shapes the product most. The answer is:
**effectively everything.**

`Client.viewer(transport)` sets mode `viewer`; every surface then rides the
injected Tauri transport and *"the Rust proxy owns address, signature, and
identity"* (`daemon/client.ts:83-89`). The client **is** the executor — a drop-in
anywhere a `CommandExecutor` goes, and the generated per-command execute
functions call it (`client.ts:96-105`, `cli/command/executor/index.ts:6-16`).

**There is no allowlist.** `daemon_execute` takes the request string, POSTs it
verbatim to the daemon's `/execute`, and stamps the *viewer's* agent identity
headers (`daemon_proxy.rs:234-259`). So a plugin tab reaches the entire generated
CLI command tree under the viewer's identity. The plugin security boundary is at
the **shell** commands (identity-derived, module-path-validated, root-only
inventory) — not at the daemon commands, which are wide open.

What matters for phosphene, from the enumerated tree:

- **`functionsExecuteStandardExecuteStreaming`** and
  **`functionsExecuteSwissSystemExecuteStreaming`** — both exist, both streaming.
  Swiss-System is a first-class peer of standard execution, not an internal
  detail. (Pass 1 established `input_split`/`input_merge` are its pooling
  mechanism.)
- **`functionsPublishExecute`** and **`functionsProfilesPublishExecute`** — a
  plugin can *publish* functions and profiles, not merely reference them. This is
  a direct, material input to §6's git-hosted-function question: the authoring
  path is not just "commit a repo," it is an SDK call.
- `functionsGet/List`, `functionsProfilesGet/List`.
- The full `channels/` group: `publish`, `close`, and
  `logs/{list,open,reply,request,subscribe}`.
- `agents/` (enqueue, get, instances, logs, token usage, MCP resources),
  `swarms/`, `laboratories/`, `db/`, `tasks/`, `development/`.

Every command also ships generated `RequestSchema` and `ResponseSchema` execute
variants — the wire shapes are introspectable at runtime, which is the direct
antidote to the old app's reverse-engineering.

**The viewer-UI surface** (`viewer.ts`) is separate from the daemon and is small
and complete: `openViewerTab`, `closeViewerTab` (three targets — self, `{key}`,
raw id), and the six mailbox helpers `sendViewerTab` / `subscribeViewerTab` /
`listViewerTab` and their `...Parent` twins.

One caveat the SDK states outright: once a child closes, `subscribeViewerTab`
**stops blocking**, so *"a bare `while (true)` loop will spin — drive it off your
own condition"* (`viewer.ts:180-186`). `home.tsx:41-52` contains exactly that
un-driven loop, flagged in §9 below.

---

## 6. The MCP half — what it buys and costs

From the root scaffold manifest and `mcp-plugin-scaffold-rs/src/main.rs`:

```json
"mcp": { "containerfile": "mcp/Containerfile", "port": 8080, "postgres": true,
         "development": { "caches": ["/build/target", "/usr/local/cargo/registry",
                                     "/usr/local/cargo/git"] } }
```

- `port` is **required and never 0**; published to a random loopback host port at
  create, and **must match the constant in the server's own source**
  (`manifest.rs:93-96`, `main.rs:33-35`).
- `postgres` is **required**, and the whole database chain hangs off it: only when
  true does the host inject the db proxy, publish its conduit port, dial it, and
  stamp `OBJECTIVEAI_POSTGRES_URL` (`manifest.rs:97-103`).
- **The database is the daemon's, tunnelled in — not private.** A plugin shares it
  with ObjectiveAI's own tables and every other plugin. Two habits follow: own a
  distinctly named table, and scope rows by the agent they belong to, "since the
  next container over is a different agent looking at the same rows"
  (`main.rs:56-64`).
- `development.caches` are **container paths** bound to persistent host dirs
  during `RUN` steps, deliberately language-agnostic (`manifest.rs:120-140`).
- Tools are `rmcp` `#[tool]` functions; the framework owns transport, port
  binding, `initialize`, and the command extension (`main.rs:1-11`).
- Tools can be **gated by agent-declared arguments** — the scaffold's `switch`
  pattern, read strictly as JSON `true` and nothing else, because "argument values
  are free-form JSON that some human typed into an agent definition"
  (`main.rs:40-50`).

Cost for phosphene: a Rust crate, a second Containerfile, a podman-backed
laboratory build in the loop, and a shared-database discipline. Buys: tools an
agent can call, channel offers, server-side session storage, and the
plugin→CLI command executor.

---

## 7. What the scaffold says a plugin *is*

The three examples are not independent demos — they compose into one story, and
that story is an argument about the archetype.

1. The **MCP half** exposes a tool an agent calls. It needs a credential.
2. It **publishes a channel offer** (`scaffold.credential`).
3. A human **accepts**; the viewer opens the matching `channel_key` handler with
   the offer as `arguments` — `{ request, response: { secret } }`
   (`credential.tsx:1-26`).
4. The handler **immediately spawns a browser tab** on a real public form with the
   plugin's declared script injected — *"the browser tab IS this handler's UI"*
   (`credential.tsx:94-101`).
5. The script paints a shadow-DOM panel, reads the field, and calls
   `__objectiveai.send({ credential })` (`capture.ts`).
6. The handler **validates it as untrusted input** (`credentialOf`,
   `credential.tsx:61-67`), writes it back with `channelsLogsReplyExecute`, then
   closes the browser tab and itself (`credential.tsx:119-139`).

`home.tsx` is the same loop with the channel removed, so the mechanism is legible
on its own.

**The archetype is: the viewer half is the human end of an agent's workflow.**
Not an application that happens to live in a tab. The tab exists because agents
cannot type into websites, cannot consent, and cannot judge.

Two design rules are stated repeatedly and should be treated as law:

- **"The spawning TAB is the trusted brain and must treat bridge messages as
  untrusted"** (scaffold `README.md`; `capture.ts` header; `SKILL.md`). Scripts
  stay dumb — read, display, send.
- **A script's entire capability surface is `__objectiveai.send/subscribe/list`.**
  No Tauri, no SDK, no network back to the viewer, because the page shares the JS
  world and anything more would be hijackable.

---

## 8. Corrections to prior research

1. **The plan's §3 said "`ViewerTab = { channel_key … } | { title … }` (untagged
   enum)" — correct, but incomplete in a way that matters.** An entry carrying
   *both* fields is not an error; it silently reads as a **handler** and drops the
   title (`manifest.rs:369-374`). Combined with tolerated unknown fields, a
   mis-authored manifest fails quietly in two different ways.

2. **§3's "the official build is a hand-written `build.mjs` over esbuild, not
   Vite" understated the asymmetry.** It is *two opposite* esbuild passes with
   inverted externals, and the node-builtins-external trick
   (`child_process`, `os`, `readline`, `node:*`) is required for the SDK to bundle
   at all. Neither was recorded.

3. **Pass 2's open question "does a plugin's CSS reach other tabs?" is answered
   NO, in the manifest's own words** — every tab is its own webview, so scope is
   the tab's own document (`manifest.rs:407-410`).

4. **`Viewer::validate` checks almost nothing.** Only `development.output` is
   validated, lexically. The plan's §7 assumed the manifest was a meaningful gate;
   it is not — the gate is the laboratory's build-time `validate_output`, and in
   development there is no gate at all, only 404s.

5. **The command surface is not narrowed for plugins.** I expected some scoping.
   `daemon_execute` proxies verbatim with no allowlist
   (`daemon_proxy.rs:234-259`); a plugin tab runs any CLI command under the
   viewer's identity. This makes the *shell* boundary (Pass 2 §9) the only real
   one, and raises the stakes on issue [#281](https://github.com/ObjectiveAI/objectiveai/issues/281)'s plugin whitelist.

6. **A bug in the scaffold, worth reporting upstream.** `home.tsx:41-52` drains
   the browser child with `for (;;) { await subscribeViewerTab(t, KEY, 60_000) }`
   and no exit condition, while the SDK doc for that very function warns that once
   the child closes it stops blocking and *"a bare `while (true)` loop will
   spin"* (`viewer.ts:180-186`). `credential.tsx:108-117` gets it right by driving
   on `credential === null`. Closing the demo browser tab spins a busy loop for
   the life of the home tab. Also `rename.sh:26` rewrites
   `.agents/skills/plugin-development/SKILL.md`, but the shipped path is
   `.agents/skills/viewer-plugin-development/SKILL.md` — a no-op, guarded by the
   `[ -f ]` check. Both are candidates for the "expect to find scaffolding bugs
   and report them" mandate in `why-rebuild.md`.

---

## 9. What this changes for phosphene

1. **Viewer-only is a hand-copy, not a scaffold mode.** `scaffold.sh` emits both
   halves and nothing else. Choosing viewer-only means copying
   `objectiveai-viewer-plugin-scaffold/` and setting `development.output: dist`.
   That is explicitly supported by its README — but it is a deviation from the
   scaffolded path, and per the brief it needs its reason written down.

2. **Publishing functions and profiles is an SDK call, not just a git ritual.**
   `functionsPublishExecute` / `functionsProfilesPublishExecute` are reachable
   from a viewer tab. The git-hosted-function direction (Pass 1 finding #3, still
   the biggest open product question) is materially cheaper than assumed.

3. **Swiss-System is a peer, not an internal.** Phosphene scores N designs against
   each other — the exact shape Swiss-System pooling exists for. It has its own
   streaming execute. Designing the review against `functionsExecuteSwissSystem…`
   rather than standard execution is now a live option with a documented mechanism
   behind it.

4. **The browser tab + script is the platform's sanctioned way to inspect a page**,
   and phosphene generates pages. Given Pass 2's finding that nothing rasterizes,
   this is the mechanism the platform actually offers for looking at a design:
   open it in real Chromium, inject a declared script, read the DOM, send
   structured findings back through the mailbox (≤256 KB). Structural, not pixels.

5. **The scaffold's archetype pulls toward an MCP half**, because the viewer half
   is framed throughout as the human end of an agent's workflow. Phosphene's
   judgment being agent-callable is the version of phosphene the platform is
   shaped for. This does not decide §6.3 — but it is the strongest single input to
   it, and it should be answered rather than defaulted.

6. **The manifest is a weak gate; CI is the real one.** Lexical validation only,
   tolerated unknown fields. The `podman build → create → cp → discard` recipe in
   the Containerfile header is the exact thing CI must run, and asserting declared
   paths exist is ours to do.

---

## 10. Open questions carried forward

**To Pass 4:** whether [#281](https://github.com/ObjectiveAI/objectiveai/issues/281) (plugin whitelist) changes the install path; whether
[#293](https://github.com/ObjectiveAI/objectiveai/issues/293) (React Fast Refresh for plugin tabs) lands before phosphene ships and
obsoletes the rung-2 build constraint; whether [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) (consolidate api +
laboratory into `objectiveai-provider`, go P2P) threatens the laboratory-based
release path.

**To the boot check** (now next):

- **Measure the reload rung a `.tsx` save actually produces** with the unmodified
  scaffold — §3's residual `copyFileSync` risk. This is the single highest-value
  measurement available and it decides a build decision.
- Does `objectiveai laboratories spawn` install podman itself, and how long does
  the first plugin build take?
- Does a registration mismatch really fail silently, as the plan's §7 claims?

**Still unread, and deferred unless §6 chooses both halves:**
`objectiveai-mcp-plugin-framework-rs/src/` (the `Tools`, `db`, and
`command_executor` surfaces), and what a plugin's own `CommandExecutor` can reach
from inside a container versus what the viewer can.

---

## 11. Addendum, 2026-08-01 — the chunk surface, which Passes 2–4 all missed

An adversarial audit of the plan found something four reading passes did not:
**the SDK ships merge helpers for exactly the streaming chunk types phosphene's
review consumes, and the obvious one is poisoned.**

Five exist in `@objectiveai/sdk` 2.2.15:

```
functionsExecutionsResponseStreamingFunctionExecutionChunkMerged
functionsExecutionsResponseStreamingTaskChunkMerged
functionsExecutionsResponseStreamingTaskChunkMergedList
functionsExecutionsResponseStreamingVectorCompletionTaskChunkMerged
functionsExecutionsResponseStreamingReasoningSummaryChunkMerged
```

**None is named anywhere in Passes 2, 3, or 4.** The reason is a real gap in
method: those passes enumerated the *request* surface — the `cli/command/` tree,
what a plugin may call — and never the *chunk* surface, what streams back. The
request side is what the old app got wrong loudly; the chunk side is what it got
wrong silently.

**The poison.** Comparing the raw and merged task-chunk types:

| type | `split_index` | `task_index` |
|---|---|---|
| `…FunctionExecutionTaskChunk` | present | present |
| `…FunctionExecutionTaskChunkMerged` | **absent** | **absent** |

`split_index` is precisely the field whose loss made the legacy app's entire
board read **0.52 while the written critique beside it was accurate** — the most
insidious bug in that repo (`legacy/00-the-old-app.md` §3). A rebuild that reaches
for the obvious SDK merge helper reproduces it exactly.

**Consequences for phosphene:**

1. **Never hand-merge a chunk, and never assume the SDK's merge is lossless.**
   Both were mistakes the old app made in different directions.
2. Before the review is built, pick the merge path deliberately and **write down
   why**, then land a regression test asserting `split_index` survives N merges.
   The old app's own best test does exactly this
   (`useDesignReview.test.ts:238-268`) and it is worth copying.
3. **Report the omission upstream.** We are pinned to 2.2.15 and this is a
   footgun in a public helper.

**Method correction for future passes:** enumerate both directions of every
surface — what we send *and* what comes back. Four passes, all thorough on
requests, all silent on chunks.
