# Phosphene rebuild — handoff

**Status: building, 2026-08-13.** The plugin is done and running — both halves,
end to end. What is live is the **expressiveness plan**: E1 shipped and was
RULED AGAINST, and the composition work is the answer to that ruling. Skip to
[Next action](#next-action) for the current list; everything between here and
there is settled history, kept because it is expensive to rediscover.

> The operative day-to-day plan is `~/.claude/plans/ancient-bubbling-beacon.md`,
> not this file. This file is the durable record; that one is the live map.
>
> **GREP THIS FILE FOR A HEADING — never read it top-down.** It is 600+ lines
> and, by design, retracted claims are left in place as blockquoted
> corrections (`verify-claims.sh` needs them there). Reading in order means
> absorbing dead claims before live ones. A cold session hit exactly that.

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
  --owner mayagore --name phosphene --version v1.0.0 --path "$PWD"
objectiveai viewer spawn
```

The tab logs `phosphene: ready · daemon round trip Nms` to
`~/.objectiveai/state/default/viewer/viewer-logs/`. A blank tab means look there
first. Tear down with `development plugins viewer delete` (same trio).

**Platform floor: ObjectiveAI ≥ 2.2.16.** Below 2.2.16, a daemon started
without the MCP timeout env silently kills any render over 60s — 2.2.16's
runner defaults that env itself (found here, fixed upstream in
ObjectiveAI#303). Below 2.2.15, no plugin tab renders at all — every entry
chunk shipped with its exports stripped (found here, fixed in
ObjectiveAI#302).

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
| Phase 4 — build (§8) | **Done 2026-08-04** — two-halves plugin, six MCP tools, postgres on |
| Phase 5 — the UI (chat concept → canvas) | **Done 2026-08-05** — `50ef1b7`…`0c143bc` |
| Phase 6 — expressiveness (E1–E4) | **E1 ruled against 2026-08-10; composition + E2 shipped in response. E3/E4 open** — see Next action |

## The §6 decisions, as made

1. **What phosphene is** — an ObjectiveAI plugin.
2. **Repo** — `mayagore/phosphene`, local `~/Programming/phosphene`. Old repo is
   `mayagore/phosphene-legacy`, kept as reference, never modified.
3. **Halves** — ~~viewer only. STANDS.~~ **REVERSED 2026-08-02: BOTH HALVES.**
   `scaffold.sh` has no viewer-only mode — its one argument is which language
   the MCP half is written in — and a viewer-only plugin can expose zero tools
   (`plugin_image.rs:283-287` hard-fails). The MCP half lives in `mcp/` and had
   three tools when this decision was written; it has **seven** now; commits
   `bfdbfe0`/`4709fcc`. The paragraph below is the earlier
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

### READ PATH — split the target, and the instruments are fine

> **Corrected 2026-08-07.** This section previously claimed that
> `agents instances get` reports `logged: 0` for runs that executed, that
> `agents logs list` returns zero rows in every target form, and that
> `logs open --id N` was the only path that worked. All three were wrong,
> reproduced live against 2.2.15. One mistake produced all of them.

A spawn prints a **path** — `daemon/<leaf>` — not an instance. Split it: the last
segment is the INSTANCE, everything before it is the PARENT. Passing the joined
string as `instance=` fabricates a target (`instance=daemon/<leaf>` resolves to
`cli/daemon/<leaf>`), which never ran, and the daemon **zero-fills** it. That
zero-fill is the `logged: 0`. The same bad target explains the empty `logs list`.

```bash
# RIGHT
objectiveai agents logs list --target "instance=$LEAF,parent=daemon" --all
objectiveai agents logs open --id 2422        # part content for a row

# WRONG — exits 0, prints nothing, reads as "the agent logged nothing"
objectiveai agents logs list --target "instance=daemon/$LEAF" --all
```

Source: `objectiveai-daemon/src/command/agents/instances/get.rs:1-4` ("always
yields an item, zero-filled when it has no activity") and `.../logs/list.rs:21-23`.

What is actually true:

- **Exactly one of `--all` / `--pending` is required.** `--pending` reads only
  unfinalized rows, so it is correctly empty for a run that has finished — which
  is indistinguishable from a bad target, since both exit 0 with no output.
- **`parent=` is absolute.** The CLI substitutes its own hierarchy only when
  `parent` is *omitted* — which is why omitting it for a spawned child finds
  nothing. `--target me` returns nothing from `logs list` because the CLI is not
  an agent.
- **A not-found row has no `error` key at all** (exit 1); a genuine failure has
  `error` populated. The response schema's `Error` variant *requires* `error`, so
  `error: null` is not a permitted shape and cannot be the discriminator.
- **`agents wait --inactive` returns `"Ok"` in 0s** and does so for an id that
  never existed, so it proves nothing on its own. `--active` is the one that
  burns the full timeout, then exits 1.
- **Latency is lane-dependent, not a contract.** A 2026-08-02 openrouter judge
  panel took ~4 minutes; a haiku probe on 2026-08-08 logged its rows in 1 second.
  Measure it, do not assume either way.
- Useful invariant: `instances get .logged` == Σ(`parts` across
  `logs list --all`) + 1. The +1 is the `agent_completion_request` blob, which
  `logs list` never emits and only `logs open --id` can read.
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

> **Corrected 2026-08-07.** This section previously said every local ObjectiveAI
> checkout was stale and would mislead you. That is no longer true of
> `~/Programming/objectiveai`, and the claim is why nobody read the source that
> would have settled several questions in an afternoon.

**`~/Programming/objectiveai` is version-exact with the installed CLI.** Confirm
before trusting it — the point is the habit, not the answer:

```bash
objectiveai --version && git -C ~/Programming/objectiveai describe --tags
```

- `objectiveai-sdk-rs/src/cli/command/agents/` — command surface and types
- `objectiveai-daemon/src/command/agents/` — what the commands actually do
- `objectiveai agents <leaf> request-schema` — Rust doc comments carry into the
  schema descriptions, so this is self-documenting and often faster than the file

The other checkouts on this machine ARE stale: `~/Desktop/work/objectiveai`
(2026-06-12, unrelated branch, 34G) and `~/oai_research/objectiveai` (2026-06-22).
Pass 1 below was read at HEAD `e79dadb` (2026-07-30) from a throwaway sparse
clone; prefer the local checkout now.
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

> **This heading is a recap, not a task.** The actual next thing to work on
> lives in `~/.claude/plans/ancient-bubbling-beacon.md` — currently Phase A,
> closing the taste loop. A cold session came here first expecting a task and
> lost a minute.

**Phases 0–5 are done.** Four platform passes, the boot check, the calibration
spikes, §6's decisions, §7's standards + CI, the two-halves build, and the UI.
The plugin runs end to end: viewer tab → one orchestrating agent → seven MCP
tools → plugin postgres → boards on a pannable canvas that export.

What follows is not the build. It is the product problem the build exposed.

### 1. E1 was RULED AGAINST. Composition is the answer. — 2026-08-10

> **Corrected 2026-08-13.** This section previously read "WAITING ON MAYA — the
> E1 A/B verdict. It gates everything in §2," and said nothing in §2 could start
> until she ruled. She ruled on 2026-08-10. Do not re-send that A/B.

Maya's diagnosis, 2026-08-06, in her own written doc: **the outputs are
formulaic.** Five causes — the expressive box (prompt-prose bans and no real
typefaces; "self-contained" was the safety property, "font-less" never was),
generator monoculture (one hardcoded seat), a conformity-shaped rubric, no
visual references, and a taste loop that was never run.

**E1 (unbox) shipped** — `8d878bd`, `0030c11`, `2b98879`: a woff2 kit inside the
MCP image, server-side `@font-face` injection, SVG invited, `fonts_embedded` /
`svg_used` surfaced as facts. **Her verdict, on the boards:** *"just added some
rotation and either name or language change — this is not accessibility or
original designs."*

**She was right, and the numbers say it more sharply than she did.** Measured
across all 18 boards of both runs: compositional vocabulary **3.44 before the
kit, 3.44 after** — identical — and the new side had *zero* grid where the old
side had it on two boards. E1 bought typography and traded grid for SVG. It did
not touch composition, because nothing in the pipeline had ever asked a model to
arrange anything, so every board was the same vertical flex stack.

**What shipped in response**, same day:

- `CompositionFacts` in `compute_facts` — grid, flex, placed, off-axis, columns,
  drawn, and `vocabulary`. It measures VOCABULARY, not quality; the claim it
  supports is that three directions returning the same numbers are not
  contrasting compositions whatever their palettes say.
- A direction must now **declare a named layout strategy**, required like the
  palette, and the three in one invention may not share one. Not a closed enum:
  six buckets would cap the design space at six.
- The renderer is told to build it, with the default named as the failure. The
  judge's `distinctiveness` now judges arrangement and says whether the markup
  delivers what was declared.

**Result, same brief, third run:** three genuinely different layouts
(`layered-overlap` / `centred-column` / `diagonal`), each direction's markup
matching its declaration, `flex` collapsed from 2–18 to 1–8. Vocabulary 4.00.

Ops traps that cost a full run, still live: the dev image does **not** rebuild
on source change (`podman rmi` first), and a daemon started outside
`scripts/resume.sh` lacks the MCP timeout env — a bare CLI read can materialize
one, so check before trusting a render.

### 2. E2 is DONE and measured. E3 and E4 remain.

- **E2 — many hands. SHIPPED and run both ways, 2026-08-10/11.** Seats are
  declarable per call (`upstream`/`model` on invent/render/refine, defaults
  unchanged). Two arms on the same brief: **opus/sonnet/haiku** (free, local
  login) and **gpt-5.6-terra / gemini-2.5-pro / deepseek-v4-pro** (cross-lab,
  ~$0.60). Seats have real signatures — opus and GPT go maximal in different
  accents, haiku and gemini restrain differently, deepseek swung widest with
  both the only 6/6 vocabulary board and the only outright render failure. The
  composition contract held across every lab that answered. **Seats matter only
  once composition is open** — before it, three models gave three flex stacks.
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
- **No tests in `viewer/`** — zero test files, no test runner in `package.json`.
  `pnpm run verify` is typecheck + build + six contract assertions.
  **`mcp/` DOES have tests** — 37 of them, `cargo test`, covering fonts, facts
  arithmetic, score clamping, the no-fabrication rule, composition counting and
  the double-escape rescue. (This bullet read "No tests exist — not in
  `viewer/`, not in `mcp/`" while its own next clause said `cargo test` covers
  the tool half. A cold session caught the contradiction; planning test work off
  the old wording would have meant rewriting 37 existing tests.)
  Tests for the salvage ladder and a contract test against a live daemon were
  named P2 in `docs/reviews/01-intention.md` and are still open.
- **CI does not build the MCP half.** `.github/workflows/ci.yml` has `verify`
  and `release-build`; `mcp/` breaks are found by hand.
- **Cost is never shown in the viewer.** The person paying cannot see the spend.
- **Tagged: `v1.0.0`, 2026-08-16**, after the production loop confirmations
  and a passing cold end-to-end run at these coordinates. Frozen forever —
  never re-cut; the release-tag rule holds for every future tag.

### 4. Owed to other people

> **Corrected 2026-08-13.** Both items in this section were wrong. The first
> read "OpenRouter key rotation is STILL unconfirmed — treat as live until
> proven otherwise"; the second said the seven findings were HELD and must not
> be sent. Neither is true any more.

- ✅ **The OpenRouter key was never exposed.** `git log --all -p` finds zero
  key-shaped matches across the entire history, and Maya read the account
  activity: every call is her own. The old "treat as live" line was a precaution
  someone wrote when unsure, and repeating it made it sound like a known leak.
  **Do not re-raise.** Standing advice that survives it: keep a per-key credit
  limit, because a readable key is *by design* (below), so a bounded key rather
  than secrecy is the defence.
- ✅ **The seven findings were sent, and Ronald answered all of them,
  2026-08-10.** Three dismissed: the readable API key is **"not an issue"** and
  intended (plugin trust is consent via his #281 whitelist, not capability
  limits); killed clients orphaning their spawns is **"actually intended"**; the
  viewer bundle is "not an issue… find some alternative solution." One shrugged
  off (`timeout_seconds`). **Three accepted as PRs WE owe him:** raise the MCP
  timeout, raise the podman VM memory on macOS specifically, propagate the real
  auth error instead of the result subtype. Session-start docs for each are at
  `~/.claude/plans/oai-pr-{1,2,3}-*.md`.
- **His rule before any of those PRs:** `install.sh --from-source`, exercise the
  fix locally, *then* open it. He reviews personally and he challenged one of
  our diagnoses already — verify in source before claiming.
- **The {ai} logo on the viewer app itself** is an upstream contribution, not
  ours — the viewer ships no app bundle and its CFBundleIdentifier is NULL.
  Ronald: a way for agents to see the viewer is eventually planned, not soon.

### Standing constraints — from the spikes, still binding

Ship our own stylesheet and consume only `@theme` tokens, never inherited
Tailwind utilities. Namespace all storage and prefer indexedDB on the shared
`tauri://localhost` origin. Never pace long work with timers. Keep the toolchain
on the scaffold's esbuild — Vite strips entry exports, which is the bug we fixed
upstream in v2.2.15, and a Vite-built plugin hits it silently in its own repo.
Legacy reuse remains prompts, rubric and design tokens — not the code.
