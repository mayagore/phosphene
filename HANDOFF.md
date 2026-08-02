# Phosphene rebuild — handoff

**Paused:** 2026-08-01. Pick up from here in a new session.

**Read in this order:** the ⚠️ ARCHITECTURE CHANGED section below (it supersedes
decision §6.3), then `docs/why-rebuild.md` (the brief, in Maya's words), then
whichever `docs/platform/*` artifact covers what you are about to touch.

## Start here

```bash
cd ~/Programming/phosphene
pnpm install && pnpm run verify        # typecheck + build + 5 contract assertions
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
| Phase 4 — build (§8) | **Paused** — scaffold boots; architecture changed, see the warning above |

## The §6 decisions, as made

1. **What phosphene is** — an ObjectiveAI plugin.
2. **Repo** — `mayagore/phosphene`, local `~/Programming/phosphene`. Old repo is
   `mayagore/phosphene-legacy`, kept as reference, never modified.
3. **Halves** — ~~viewer only~~ **SUPERSEDED 2026-08-01 — see the ARCHITECTURE
   CHANGED section below. Phosphene needs the MCP half.** The viewer scaffold
   was hand-copied (`scaffold.sh` emits both halves); that part still stands.
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

- **§6.3 FLIPS — phosphene needs the MCP half.** We decided viewer-only; that
  decision is now wrong. Viewer-only can display an agent's work but cannot
  score without violating the daemon rule.
- **§6.1 narrows**: the viewer half is a display surface, not the app.
- **The review is not built on functions.** Scoring goes plugin-side, invoked by
  an agent as a tool.
- **Script agents** (`.agents/skills/script-agents/SKILL.md`) run Python on the
  client's embedded runtime with no model and no token cost, and can call plugin
  tools — a strong candidate for deterministic orchestration.

### What survives — nearly everything

The scaffold, `build.mjs`, CI, the five contract assertions, the design tokens,
all nine research docs, and the verified boot path do not care who orchestrates.
The tab is a display either way.

### UNVERIFIED, and it is load-bearing

**Can an MCP plugin actually reach a vector completion (or equivalent) from
inside its container, and with what credentials?** The whole redesign rests on
yes. A workflow was investigating this when the session ended; if its verdict is
lost, re-run it:

```
Workflow({scriptPath: "~/.claude/projects/-Users-maya-phosphene/93a8c66c-a6d5-4f91-a4cd-54d20a9ea59b/workflows/scripts/verify-mcp-scoring-wf_dbdade9b-1ff.js"})
```

If the answer is **no**, the leading alternative is a script agent orchestrating
N agent completions with `top_logprobs` and combining the votes itself — a
hand-rolled swarm. That needs its own verification.

**Do not refactor until this is settled.**

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
- **`functionsExecuteStandardExecuteStreaming` is unusable at 2.2.15** — it
  zod-validates responses, the server strips `plugins` from echoed agents, and
  it throws out of an async iterator. Consume raw via `executor.execute()`.
  Fifth upstream defect; unreported.
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

**Every local ObjectiveAI checkout on this machine is stale and will mislead
you.** `~/Desktop/work/objectiveai` and `~/Programming/objectiveai` are at
2026-06-12; `~/oai_research/objectiveai` at 2026-06-22. The plugin system was
rebuilt 2026-07-28 and the scaffolder shipped 2026-07-30. All three carry a
top-level `PLUGINS.md` that no longer exists upstream. **Read HEAD, always.**

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
[PR #302](https://github.com/ObjectiveAI/objectiveai/pull/302) → `v2.2.15`.

**Verified end to end on 2026-08-01:** a scaffold extracted fresh from the
`v2.2.15` tag builds, registers, and its tab renders — proven positively with a
`console.log` probe reaching the viewer log inbox, not merely by absence of
errors. See `docs/spikes/00-boot-check.md`.

**Spikes A–E are unblocked.** One constraint survives and is ours: the
scaffold's watch build rewrites every stylesheet on every rebuild, so a `.tsx`
save always costs a full webview reload instead of the cheap remount. Making
that copy conditional is a phosphene build decision, not an upstream one.

## Next action

**All four platform passes, the boot check, and the calibration spikes are done.**
Everything §4 and §5 asked for exists. Next is **§6's five decisions** — the
first thing in this project that writes phosphene's own design down.

**Inference is verified end to end (2026-08-01).** An OpenRouter key is now
configured, and a real agent completion ran from inside a plugin tab through
`Client.viewer(transport)` — 5 chunks in 930 ms, answer `"pong"`, persisted and
read back. An **OpenRouter key alone is sufficient**; no ObjectiveAI `apk_` key
was needed. See `docs/spikes/01-calibration.md` §A.

**Remaining:** a full *function execution* (`functionsExecuteStandard…` /
`…SwissSystem…`) has not been run, because it needs a published function and
swarm — that is §6 work, not calibration. Everything underneath it (transport,
streaming, identity, persistence, concurrency) is verified.

Inputs §6 now has that it did not before:

- **§6.1 (what phosphene is)** — Pass 3: the scaffold's archetype is "the viewer
  half is the human end of an agent's workflow." Pass 1: the judging half is the
  platform-native half.
- **§6.3 (viewer-only vs. both halves)** — `scaffold.sh` emits only both halves,
  so viewer-only is a hand-copy needing a written reason. **But Spike D reversed
  a key input**: in-page rasterization works, so phosphene does *not* need an MCP
  half merely to see its own output. Track issue #287 (a JS MCP scaffold) before
  committing to Rust.
- **§6.4 (what to consult from the old repo)** — unchanged, default nothing.
- **§6.5 (toolchain)** — stay on the scaffold's esbuild. Vite strips entry
  exports (the bug we fixed upstream in v2.2.15); a Vite-built plugin hits it
  silently in its own repo. Also: make the stylesheet copy conditional, or every
  `.tsx` save costs a full reload.

Standing constraints from the spikes, for whatever §6 decides:
ship our own stylesheet and consume only `@theme` tokens, never inherited
Tailwind utilities; namespace all storage and prefer indexedDB on the shared
`tauri://localhost` origin; never pace long work with timers.
