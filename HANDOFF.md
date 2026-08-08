# Phosphene rebuild — handoff

**Status: building, 2026-08-07.** The plugin is done and running — both halves,
end to end. What is live now is the **expressiveness plan (E1–E4)**, and E1 is
waiting on Maya's A/B verdict. Skip to [Next action](#next-action) for the
current list; everything between here and there is settled history, kept because
it is expensive to rediscover.

## ⚠️ LEAN TRANSIT (2026-08-07) — the board-payload contract

Boards never ride a model's context at full weight. `render_state`,
`refine_state` and `get_state` return the stored document with font payloads
ELIDED (`base64,ELIDED` stubs) plus `bytes_stored` / `fonts_embedded` /
`svg_used`; the full document lives only in plugin postgres. The VIEWER owns
the payloads — `viewer/src/lib/fontkit.generated.ts`, generated from
`mcp/src/fonts.rs` + `mcp/fonts/` by `viewer/scripts/gen-fontkit.mjs`, kept
honest by contract check 6 — and re-attaches them at display and export time
(`attachKit`). If you touch the kit, regenerate and commit; if you add a tool
that returns a board, return `lean_rendered(...)`, never raw html.

Operational sibling: `scripts/resume.sh` now exports `MCP_TOOL_TIMEOUT`,
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` and `MAX_MCP_OUTPUT_TOKENS` before
spawning the daemon — claude's MCP client otherwise kills any tool call
silent for 60s, which presents as "The operation timed out." on every render
and orphans the nested completion. A daemon started WITHOUT these must be
killed and respawned through the script.

**Read in this order:** the ⚠️ ARCHITECTURE CHANGED section below (it supersedes
decision §6.3), then `docs/why-rebuild.md` (the brief, in Maya's words), then
whichever `docs/platform/*` artifact covers what you are about to touch.

## Start here

```bash
cd ~/Programming/phosphene
bash scripts/resume.sh                  # daemon → laboratory → BOTH registrations → viewer
cd viewer && pnpm install && pnpm run verify   # typecheck + build + 6 contract assertions
cd ../mcp && cargo test                        # the tool half
```

To see it running in the viewer:

```bash
pnpm run dev &                          # watch build -> dist/
objectiveai development plugins viewer create \
  --owner mayagore --name phosphene --version v0.1.0 --path "$PWD"
objectiveai viewer spawn
```

The tab logs `phosphene: ready · daemon round trip Nms` to
`~/.objectiveai/state/default/viewer/viewer-logs/`. A blank tab means look there
first. Tear down with `development plugins viewer delete` (same trio).

**Platform floor: ObjectiveAI ≥ 2.2.15.** Earlier releases cannot render ANY
plugin tab — every entry chunk shipped with its exports stripped. Found here,
fixed upstream in ObjectiveAI#302.

## Repo layout — settled

**GitHub `mayagore/phosphene`, local `~/Programming/phosphene`.** Forced, not
chosen: the repo name IS the plugin name on release.

The old app lives at `mayagore/phosphene-legacy`, checked out at
`~/phosphene`. **Reference only — never modify it.** It has one uncommitted
change of Maya's (`scripts/install-dev.sh`) that predates this work; leave it.
Its postmortem is `docs/legacy/00-the-old-app.md`, and the verdict is: take the
prompts, the rubric and the design tokens; leave the code.

The `~/phosphene-rebuild/` staging directory is retired — everything moved here
and is committed. It can be deleted.

The original approved plan is at
`/Users/maya/.claude/plans/we-will-need-to-elegant-truffle.md`. It is still
broadly right, but §6.3 is now superseded — see below.

## Where we are

| Phase | Status |
|---|---|
| Pass 0 — why we're rebuilding | **Done** → `docs/why-rebuild.md` |
| Pass 1 — purpose and foundations | **Done** → `docs/platform/00-what-this-is.md` |
| Pass 2 — the viewer | **Done** → `docs/platform/01-viewer.md` |
| Pass 3 — the plugin contract | **Done** → `docs/platform/02-plugin-contract.md` |
| Scaffold boot check | **Done — PASSES on v2.2.15** → `docs/spikes/00-boot-check.md` |
| Pass 4 — recency and trajectory | **Done** → `docs/platform/03-changelog.md` |
| Phase 1 — calibration spikes A–E | **Done** → `docs/spikes/01-calibration.md` |
| Phase 2 — decisions (§6) | **Done** — see below |
| Phase 3 — standards + CI (§7) | **Done** — `pnpm run verify`, `.github/workflows/ci.yml`, CI green |
| Phase 4 — build (§8) | **Done 2026-08-04** — two-halves plugin, five MCP tools, postgres on |
| Phase 5 — the UI (chat concept → canvas) | **Done 2026-08-05** — `50ef1b7`…`0c143bc` |
| Phase 6 — expressiveness (E1–E4) | **E1 shipped, awaiting Maya's A/B verdict** — see Next action |

## The §6 decisions, as made

1. **What phosphene is** — an ObjectiveAI plugin.
2. **Repo** — `mayagore/phosphene`, local `~/Programming/phosphene`. Old repo is
   `mayagore/phosphene-legacy`, kept as reference, never modified.
3. **Halves** — ~~viewer only. STANDS.~~ **REVERSED 2026-08-02: BOTH HALVES.**
   `scaffold.sh` has no viewer-only mode — its one argument is which language
   the MCP half is written in — and a viewer-only plugin can expose zero tools
   (`plugin_image.rs:283-287` hard-fails). The MCP half lives in `mcp/` with
   three tools; commits `bfdbfe0`/`4709fcc`. The paragraph below is the earlier
   history, kept as written: (Briefly retracted on 2026-08-01 in
   favour of adding the MCP half; that retraction was itself wrong and is
   withdrawn — a script agent covers scoring with no container. See the
   ARCHITECTURE CHANGED section.) The viewer scaffold was hand-copied;
   `scaffold.sh` only emits both halves.
4. **Legacy reuse** — prompts, the scoring rubric, and the design tokens. Not the
   code. → `docs/legacy/00-the-old-app.md`.
5. **Toolchain** — the scaffold's esbuild. Vite strips entry exports, which is
   the bug we fixed upstream in v2.2.15; a Vite-built plugin hits it silently.

## ⚠️ ARCHITECTURE CHANGED — 2026-08-01, read this first

**Ronald (the platform owner), asked directly whether functions are staying:**

> "I would refactor it to use agent completions directly and avoid using the
> functions feature. that will make it safe. also remember to do all work
> through the daemon — the viewer shouldn't do work directly, it should moreso
> be a display for what the agent is doing using tools. you can also use script
> agents to call tools arbitrarily"

**This inverts the design.** We built phosphene as an app that orchestrates:
it calls the API, generates, scores, renders. Ronald describes phosphene as a
**display onto an agent that orchestrates**, with the work in the daemon and
the agent reaching phosphene's tools.

It also vindicates Pass 3, which found the scaffold's archetype is "the viewer
half is the human end of an agent's workflow" (`docs/platform/02-plugin-contract.md`
§7). That was flagged at the time and we chose the app model anyway.

### Why "no functions" and "through the daemon" are one statement

From a viewer plugin, verified 2026-08-01:

| path | daemon-reachable? |
|---|---|
| agent completions | YES — `agents spawn` → `/execute` |
| **functions** | YES → but being deprecated |
| **vector completions** | **NO — HTTP API only** |

The viewer's daemon proxy exposes exactly `/execute`, `/listen`,
`/agents/instances/list`, `/laboratories/list`, `/channels` — no vector route.
The CLI has no vector command, so `/execute` cannot reach one either. And the
SDK's `vectorCompletionsCreateVectorCompletion` takes an `ObjectiveAI` HTTP
client, not a `CommandExecutor` — i.e. an API key in the webview, which is
exactly what Ronald ruled out.

**Functions were the only daemon-safe route to swarm scoring.** Remove them and
scoring has to move somewhere a key is legitimate: a plugin container.

### What this changes

- **§6.1 narrows**: the viewer half is a display surface, not the app.
- **The review is not built on functions.** Scoring is reconstructed as N agent
  completions, orchestrated by a script agent — see the verified answer below.
- ~~**§6.3 STANDS. Viewer-only is still correct.** An intermediate conclusion that
  the MCP half was now required was **wrong and has been retracted** — see below.~~
  **REVERSED AGAIN 2026-08-02, and that reversal is the one that held.** Both
  halves ship. Not because scoring needs the MCP half — the reasoning below is
  still sound — but because `scaffold.sh` has no viewer-only mode and a plugin
  exposing zero tools hard-fails (`plugin_image.rs:283-287`). See §6 decision 3.

### VERIFIED 2026-08-01 — how scoring works without functions

Investigated across the framework, the laboratory's container setup, and the
alternatives. Verdict: **a plugin can never do a vector completion — nothing can
via the CLI — but multi-agent scoring is reachable as N agent completions.**

Evidence, each checked against source:

- `objectiveai-sdk-rs/src/cli/command/command.rs` — `Subcommand`, `Request`,
  `ResponseItem` and `ListenerExecution` all enumerate the same 13 groups, with
  **zero occurrences of "vector"**. There is no vector module at HEAD.
- `vector/completions/http.rs:9-16` — both entry points take `&HttpClient` and
  are gated `#[cfg(feature = "http")]` (`mod.rs:9-13`), while
  `objectiveai-mcp-plugin-framework-rs/Cargo.toml:21` pins the SDK
  `default-features = false, features = ["cli","cli-executor"]`. **The function
  is not compiled into a plugin binary at all.**
- `swarms --help` → `get | list | publish`. Nothing *executes* a swarm; it is a
  resource, not an execution mode.
- `agents spawn request-schema` — `top_logprobs` is marked *"Vector completions
  only. Ignored for agent completions."*

**So the shape is:**

| layer | what it does |
|---|---|
| **viewer half** | one `agents spawn` of an orchestrator, then `agents logs subscribe` and render. Pure display. Fits the single-in-flight invoke limit. |
| **script agent** | fans out N judges via `objectiveai.execute(argvs)`, verified parallel by design (`objectiveai-rustpython-wasm/src/main.rs:70-76`). Python, no model, no token cost. |
| **each judge** | `agents spawn --agent-inline`, one model each. Votes combined with `objectiveai_sdk::Weights` (ungated, available). |
| **MCP half** | **not needed for scoring** — still true. It was built anyway (2026-08-02, forced by the scaffold), and it now holds the tools, the font kit and the postgres store. |

**The cost: no logprobs.** `top_logprobs` is ignored for agent completions, so
this is discrete voting, not calibrated preference distribution. A real
downgrade, and it is the platform's headline feature.

**But it is smaller than it looks.** Our own 4-model run was already **7 of 8
votes one-hot** — only qwen returned a distribution. In practice the signal came
from *model diversity*, which this preserves completely. Worth re-measuring
rather than assuming either way.

**Second trade-off:** a flat batch is all-or-nothing — one failed judge kills the
panel. Wrap each judge in per-command error handling instead.

### Upstream security finding — worth reporting

`objectiveai api config objectiveai-authorization` exists and is readable, so a
plugin **can read the user's API key and call the API directly**, bypassing the
daemon entirely. That is precisely the hole "do all work through the daemon /
that will make it safe" is aimed at, and the conduit
(`websocket_laboratory.rs:539-554`) has **no command allowlist or denylist**.

Unlike the functions defect, this one is worth telling Ronald about — but
**Maya said "dont send anything" when it was found, and that still stands.**
It is written up and held with the other six. See Next action §4.

### What survives — nearly everything

The scaffold, `build.mjs`, CI, the contract assertions, the design tokens,
all nine research docs, and the verified boot path do not care who orchestrates.
The tab is a display either way.

### ~~The one remaining unknown~~ — SETTLED 2026-08-02

**Does a nested, COST-BEARING `agents spawn` succeed from inside a script agent?
YES.** Verified twice, in two separate sessions, against the log tier.

A script agent calling `objectiveai.execute(argvs)` with two judge argvs returns
real instance handles (`FANOUT_RESULT [["daemon/6JSFmNWghnguySl3M1Lgt0-…`) and both
judges issue completion requests and answer:

| log id | time (UTC) | row |
|---|---|---|
| 1637 | 00:29:42 | `REQ openai/gpt-4o-mini` |
| 1638 | | → `Bad.` |
| 1640 | 00:29:44 | `REQ mistralai/mistral-nemo` |
| 1641 | | → `Bad` |

**The judge that came back empty on 2026-08-01 was a transient upstream failure,
not a batch defect.** Log row 1632 is explicit:

```json
{"code":500,"message":{"kind":"openrouter","error":{"kind":"stream_error","error":"Stream ended"}}}
```

Two consequences, and the second is the useful one:

1. Neither the model nor the 8-token cap is implicated — mistral-nemo answered
   normally on the rerun.
2. **The failure is logged, so a missing judge is detectable.** Per-judge error
   handling is still mandatory, but it can be *explicit*: detect the error row
   against that seat and retry or degrade with the panel size recorded. This is
   strictly better than the feared silent average over a hole.

### ~~READ PATH — most instruments lie~~ — WRONG. Retracted 2026-08-07.

**The instruments do not lie. We were holding one of them wrong**, and every
"defect" below followed from that single mistake. Reproduced live at 2.2.15.

**The root cause: passing the JOINED hierarchy as `instance=`.** A spawn prints
a path (`daemon/<leaf>`). Passing `--target "instance=daemon/<leaf>"` resolves to
`cli/daemon/<leaf>` — an AIH that never ran — and the daemon **zero-fills** it.
Pass the leaf alone: `--target "instance=$LEAF,parent=daemon"`.

The retracted claims, each corrected:

- ~~`agents instances get` reports `logged: 0` for runs that executed.~~ It
  agrees with `instances list` when the target is correct. `logged: 0` was the
  zero-fill. Source: `objectiveai-daemon/src/command/agents/instances/get.rs:1-4`
  — *"always yields an item, zero-filled when it has no activity."*
- ~~`agents logs list` returns zero rows in every target form.~~ It works:
  `--target "instance=$LEAF,parent=daemon" --all`. Zero rows come from omitting
  the required `--all`/`--pending`, from `--pending` on a finished run, or from
  `--target me` (the CLI is not an agent). Source: `.../logs/list.rs:21-23`.
- ~~The path that works is bisecting `logs open --id`.~~ Not needed. Read the run
  with `logs list … --all`, then `logs open --id N` for part content.
- ~~A not-found row has `error: null`.~~ It has **no `error` key at all**
  (exit 1) — the schema's `Error` variant requires `error`. Real failures have it
  populated. That absence is the reliable discriminator.
- ~~`agents wait --inactive` consumes its entire timeout budget.~~ It returns
  `"Ok"` in **0s**. `--active` is the one that burns the timeout and exits 1.
- **`parent=` is ABSOLUTE**, not caller-relative. The CLI substitutes its own
  hierarchy only when `parent` is *omitted*.

**Latency is lane-dependent, not a contract.** A 2026-08-02 openrouter judge
panel took ~4 minutes; a haiku probe on 2026-08-08 logged its rows in 1 second.
Measure it; do not assume either way. (The earlier "minutes, not seconds" was
one lane generalized into a rule.)

**The intended model, from Ronald 2026-08-07:** spawn and message RETURN the
AIH; you keep that handle and use it for `logs subscribe` / `list`. There is no
"find the orphan" query because you are not meant to lose the handle.

Invariant worth keeping: `instances get .logged` == Σ(`parts` over
`logs list --all`) + 1. The +1 is the `agent_completion_request` blob, which
`logs list` never emits and only `logs open --id` can read.

**The lesson is bigger than the commands.** This section sat here for days
asserting the platform was broken, and it was read as settled fact because it was
written down. Prefer source — it is readable, see below — over any claim in this
file, including this one.

### Why functions are going away — the bigger picture

Ronald, in the same conversation:

> "we're switching to a P2P architecture and we are working on an API spec for
> providers
>
> it will be like this: https://modelcontextprotocol.io/docs/2026-07-28/getting-started/intro
>
> but unlike MCP, we will also have a de-facto implementation binary you can run"

**ObjectiveAI is being rebuilt as a protocol** — a spec others implement, plus a
reference binary — rather than one company's hosted API.

This reframes the "avoid functions" advice. It was never "functions are buggy."
Functions live in the API layer, and **that whole layer is being replaced** by a
provider spec. Agent completions and tools survive because they are the parts
becoming the spec.

**This confirms the biggest risk Pass 4 identified.** `docs/platform/03-changelog.md`
§4 named issue [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) — *"make objectiveai P2P; consolidate objectiveai-api and
objectiveai-laboratory into new objectiveai-provider"* — as the only open item
that could invalidate an entire research pass. It is no longer speculative; it
is the roadmap. Related: [#298](https://github.com/ObjectiveAI/objectiveai/issues/298)/#299/#300 (containerize agent upstreams behind one
consolidated API spec, with Rust and Python frameworks).

**Three consequences, in order of importance:**

1. **The MCP half is right for a better reason than we knew.** If the future is
   explicitly MCP-shaped, a plugin exposing tools is on the correct side of the
   restructure. §6.3's flip is reinforced, not merely forced.
2. **Build thin, not deep, against today's API shapes.** Keep phosphene's own
   logic in phosphene's code. Anything that reaches into a specific ObjectiveAI
   request/response shape should be a thin, replaceable seam — because those
   shapes are the ones being respecified.
3. **Expect the plugin contract to move at least once more.** Pass 4 measured
   ~75% of upstream commits touching our surface and 37 breaking commits across
   six releases. A P2P restructure will not lower that.

**The disposition this implies:** we are the first real application on a young
platform that is mid-restructure. That is the reason four of our five upstream
findings existed at all. Treat "the platform moved" as a normal, planned-for
event — keep the `docs/platform/*` artifacts current with their `Read at:` SHAs,
keep the contract assertions in CI, and re-run the boot check on every bump.
Do not treat it as a crisis, and do not build as though the ground is fixed.

## In flight, 2026-08-01

### The swarm works, and diversity is what makes it work

A real 4-model function execution ran on 2026-08-01 — **$0.000266, 30s, 78
chunks**, no task errors, overall `0.586`. Artifacts in `~/oai-swarm/`
(`function.json`, `profile.json`, `input.json`, `stream.ndjson`).

**Four models, one design, per-dimension votes:**

| | gemma-3-27b | llama-3.1-8b | mistral-nemo | qwen3-30b |
|---|---|---|---|---|
| visual hierarchy | strong | **poor** | strong | **exceptional** |
| contrast | adequate | weak | **strong** | strong |

They span the whole ladder — one model says *poor* where another says
*exceptional* on identical input. **That is genuine inter-model disagreement,
not sampling noise, and a single-model swarm would have reported one of those
with false confidence.** This is the strongest evidence that phosphene belongs
on this platform, and it is the first time anyone has tested the claim — the
legacy app's "swarm" was N byte-identical agents.

**The catch: 7 of 8 votes came back ONE-HOT.** Only qwen returned a real
distribution (`0.231 adequate / 0.768 strong`). So the value we captured came
from model *diversity*, not from distributional logprob voting. Unexplained —
candidates are cheap models being sharp on a 5-way single-token choice,
`max_tokens: 16` being too tight, or `top_logprobs: 20` not reaching some
upstreams. **Worth a spike**: if distributional voting cannot be made to work,
lean on more diverse agents rather than richer per-agent signal.

Carry this forward regardless of how scoring is wired: the 5-rung
natural-language ladder, and diversity as the source of signal.

### Verified facts worth not rediscovering

- `split_index` is **absent** when `split:false`; `task_index` is on every
  vector chunk. `split` is the *batch* axis (score many candidates), not the
  dimension axis. The legacy app's flagship bug lived in a path we may not need.
- **`functionsExecuteStandardExecuteStreaming` is broken at 2.2.15 — and it does
  NOT matter to us.** It zod-validates every stream item and ends in a `parse()`
  that throws out of an async iterator; the server strips `plugins` from the
  echoed `agent_inline` while the response schema requires it. Verified on our
  own run: sent `plugins: []` on 4 agents, 0 came back with it; replaying the
  77-line stream through `CliCommandFunctionsExecuteStandardResponseItemSchema`
  gives 69 pass / **8 fail**, all on `agent_inline.plugins` (8 = 4 agents × 2
  tasks).

  **The agent-completion path is clean.** A real `agents spawn` stream validated
  against `CliCommandAgentsSpawnResponseItemSchema`: **5 items, 5 pass, 0 fail.**
  Agent-completion chunks carry no `agent_inline` at all, so the defect
  structurally cannot occur there.

  **Deliberately NOT reported.** It is a bug in a feature the platform owner has
  told us to stop using, on a layer being replaced wholesale. Filing it would be
  noise. Recorded here only so nobody rediscovers it and panics.
- `{"$special":"task_output_weighted_sum"}` is correct for a ladder collapse.
  Hand-writing `output['scores'][i]` fails *after* paying for inference —
  `output` is a bare list.
- Mock agents (`"upstream":"mock"`) are a free syntax linter for expressions and
  transport. They never vote; never read their numbers.

**Sequencing change, 2026-07-31.** The boot check moves between Pass 3 and Pass 4.
Not before Pass 3, because Pass 3 *is* the scaffold and running it unread is
driving blind. But before Pass 4, because trajectory reads better once you have
hit real breakage, and §9 flags "the scaffold may not work first try" as live.

## The brief, in one line

Rebuild phosphene to fit the new scaffolding properly, because nobody has ever
actually used that scaffolding. **Fidelity to the scaffold is the goal;
deviation needs a written reason.**

## Read this before touching anything

~~**Every local ObjectiveAI checkout on this machine is stale and will mislead
you.** `~/Desktop/work/objectiveai` and `~/Programming/objectiveai` are at
2026-06-12; `~/oai_research/objectiveai` at 2026-06-22.~~

**CORRECTED 2026-08-08: `~/Programming/objectiveai` is now at
`objectiveai-sdk-go/v2.2.15`, version-exact with the installed CLI — it is
readable and it is the fastest way to check platform behavior.** Confirm before
trusting it:

```bash
objectiveai --version && git -C ~/Programming/objectiveai describe --tags
```

The other two checkouts are still stale and still carry a top-level `PLUGINS.md`
that no longer exists upstream. The plugin system was rebuilt 2026-07-28 and the
scaffolder shipped 2026-07-30. **When the local checkout does not match the
installed CLI, read HEAD.** Prefer reading source (or `<leaf> request-schema`,
which carries the Rust doc comments) over believing any written claim in this
file — several recorded "the instrument is broken" findings turned out to be
usage errors.

Working checkout used for Pass 1 (blobless sparse clone, scratchpad — recreate it
rather than trusting it to persist):

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/ObjectiveAI/objectiveai
```

Everything so far was read at HEAD `e79dadb` (2026-07-30).

## Findings that change what gets built

1. **The platform's docs are split.** The root `README.md` omits Functions,
   Profiles, and the expression system entirely — they are only in root
   `CLAUDE.md`. Function execution is the layer phosphene's review runs on.
   Reading only the README is how the old app ended up guessing wire shapes.

2. **Open, and the brief tilts it:** phosphene's review function and profile can
   be **git-hosted, content-addressed, commit-pinned, and trained** (`function.json`
   / `profile.json`; the org publishes `profile-nano` … `profile-giga-max`). The
   old app assembled them inline in TypeScript per request. The platform's
   intended way is the former. → §6.

3. **`input_split` / `input_merge` are Swiss-System tournament pooling.** That is
   the documented mechanism behind the `split_index` the old app lost every score
   to (commit `360576f`). Design against the mechanism, never observed JSON.

4. **Three hand-rolled mechanisms have upstream equivalents — delete them.** The
   vector client attaches cumulative scores to every chunk by design; there is a
   first-chunk error contract at every layer (a leading error is a rejection, not
   a chunk); `objectiveai-api/src/functions/executions/ERRORS.md` gives an
   exhaustive fatal-vs-advisory taxonomy with explicit tolerances (scalar
   `[-0.01, 1.01]`, vector sum `[0.99, 1.01]`).

5. **Nothing upstream catches a bundled React.**
   `objectiveai-laboratory/src/viewer_build.rs` says outright: *"the ONE invariant
   we cannot enforce is the author's."* It fails at runtime on the first hook. Its
   `validate_output` (line 207) does check that every declared tab module,
   stylesheet, script module, and icon exists in the output — that is the release
   gate to mirror in CI, and now we have its exact semantics.

6. **The README's "sandboxed iframe tabs" is stale prose.** No iframes exist in
   the plugin path; tabs are Tauri child webviews and browser tabs are native CEF
   windows. This repo's docs lag its Rust — treat source as authoritative and
   record disagreements.

## ~~Blocker~~ — RESOLVED 2026-08-01 in v2.2.15

Plugin tabs could not render on v2.2.14: every `host/*` shim and `tabs/*` module
shipped exporting **nothing**, because Vite's app build strips entry signatures
and neither import path (the `tab.html` import map, `tab.tsx`'s `@vite-ignore`
dynamic import) is a module-graph edge. Fixed with
`preserveEntrySignatures: "strict"`, plus two lesser defects, in
[PR [#302](https://github.com/ObjectiveAI/objectiveai/issues/302)](https://github.com/ObjectiveAI/objectiveai/pull/302) → `v2.2.15`.

**Verified end to end on 2026-08-01:** a scaffold extracted fresh from the
`v2.2.15` tag builds, registers, and its tab renders — proven positively with a
`console.log` probe reaching the viewer log inbox, not merely by absence of
errors. See `docs/spikes/00-boot-check.md`.

**Spikes A–E are unblocked.** One constraint survives and is ours: the
scaffold's watch build rewrites every stylesheet on every rebuild, so a `.tsx`
save always costs a full webview reload instead of the cheap remount. Making
that copy conditional is a phosphene build decision, not an upstream one.

## Next action

**Phases 0–5 are done.** Four platform passes, the boot check, the calibration
spikes, §6's decisions, §7's standards + CI, the two-halves build, and the UI.
The plugin runs end to end: viewer tab → one orchestrating agent → five MCP
tools → plugin postgres → boards on a pannable canvas that export.

What follows is not the build. It is the product problem the build exposed.

### 1. WAITING ON MAYA — the E1 A/B verdict. It gates everything in §2.

Maya's diagnosis, 2026-08-06, in her own written doc: **the outputs are
formulaic.** Five causes — the expressive box (prompt-prose bans and no real
typefaces; "self-contained" was the safety property, "font-less" never was),
generator monoculture (one hardcoded seat), a conformity-shaped rubric, no
visual references, and a taste loop that was never run. The approved fix is
four phases, **each gated on a same-brief A/B judged by Maya's eye.**

**E1 (unbox) shipped** — `8d878bd`, `0030c11`, `2b98879`: a woff2 kit inside the
MCP image, server-side `@font-face` injection, SVG invited, the "contemporary
baseline" paragraph deleted, `fonts_embedded` / `svg_used` surfaced as facts.
The A/B rendered 9/9 and went to Maya 2026-08-07 — new `307daa12-…` against old
`22711796-…`, same night-market-haiku brief, ~86–125KB boards against ~7–11KB.

**Nothing in §2 starts until she rules.** Re-render or re-send runbook: the
`expressiveness` memory, which also holds the two ops traps that cost a full run
(the dev image does NOT rebuild on source change — `podman rmi` first; and a
daemon started outside `scripts/resume.sh` lacks the MCP timeout env).

### 2. Then E2 → E4, in order

- **E2 — many hands.** A model seat per direction, replacing the one hardcoded
  `GENERATION_UPSTREAM`/`MODEL` in `mcp/src/main.rs`. `run_agent` already takes
  model and upstream per call, so this is roster work, not plumbing. **Maya
  picks the roster** and the cost envelope (default $1).
- **E3 — the funnel.** Restore ideate → judge → draft → judge → explore → judge
  → human as stage tools with their own rubrics, human gates default OFF. This
  was in the design and dissolved when functions were retired. It was never
  consciously cut.
- **E4 — references.** Text and SVG first, rasters after. Carries a reserved
  decision: judges read ~30KB of *markup*, not pixels, so vision-judging either
  becomes real pixels or the word goes.

**The standing rule from this plan: variety must be bred, not prompted.** Never
re-add material bans to the prompts, and never ship an expressiveness change
without an A/B on an unchanged brief.

### 3. Open, unblocked, nobody is waiting on them

- **`list_explorations` tool.** The viewer resumes an id but cannot list ids, so
  every past exploration is unreachable unless you kept the uuid.
- **Per-round artboard rows.** Renders currently overwrite. One row per round is
  what unlocks undo and diffs.
- **No tests exist** — not in `viewer/`, not in `mcp/`. `pnpm run verify` is
  typecheck + build + six contract assertions; `cargo test` covers the tool half.
  Tests for the salvage ladder and a contract test against a live daemon were
  named P2 in `docs/reviews/01-intention.md` and are still open.
- **CI does not build the MCP half.** `.github/workflows/ci.yml` has `verify`
  and `release-build`; `mcp/` breaks are found by hand.
- **Cost is never shown in the viewer.** The person paying cannot see the spend.
- **Never tagged.** No git tag exists. The frozen-tag rule applies at `v0.1.0` —
  tag deliberately.

### 4. Owed to other people

- 🔴 **OpenRouter key rotation is STILL unconfirmed.** The key behind every judge
  in this repo's history. Treat as live until proven otherwise.
- **Seven platform findings for Ronald are written up and HELD** — full list in
  the `platform-findings` memory. **Maya has not said send. Do not send them.**
  She said "dont send anything" about the security one specifically (a plugin can
  read the user's API key via `objectiveai api config objectiveai-authorization`
  and bypass the daemon; the command lane has no allowlist).
- **The {ai} logo on the viewer app itself** is an upstream contribution, not
  ours — the viewer ships no app bundle and its CFBundleIdentifier is NULL.

### Standing constraints — from the spikes, still binding

Ship our own stylesheet and consume only `@theme` tokens, never inherited
Tailwind utilities. Namespace all storage and prefer indexedDB on the shared
`tauri://localhost` origin. Never pace long work with timers. Keep the toolchain
on the scaffold's esbuild — Vite strips entry exports, which is the bug we fixed
upstream in v2.2.15, and a Vite-built plugin hits it silently in its own repo.
Legacy reuse remains prompts, rubric and design tokens — not the code.
