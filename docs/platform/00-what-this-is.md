# What ObjectiveAI is

> **SUPERSEDED IN PART (2026-08-03).** Functions and vector-completion
> mechanics described below are read-accurate for 2.2.15 but are no longer
> the platform's direction and phosphene must not build on them — no
> functions, no distributed votes.
> Design directives in this file that assume vector completions are void.

> **Read at:** `ObjectiveAI/objectiveai` @ `e79dadb3e77a0f9ebb349677c6e0dbf8d6e20983` — 2026-07-30 03:38:56 -0500
> **Pass:** 1 of 4 — purpose and foundations
> **Written:** 2026-07-31

**Sources read in full:** root `README.md` (633 lines), root `CLAUDE.md` (192),
`objectiveai-api/CLAUDE.md`, `objectiveai-api/src/functions/executions/ERRORS.md`,
`objectiveai-api/src/agent/completions/CLAUDE.md`,
`.agents/skills/agent-control/SKILL.md`. **Skimmed:** `SDK.md` (72 lines, build
pipeline only), `objectiveai-daemon/README.md` (a stub — it is actually the CLI
README, mislabeled). **Not yet read:** `examples/`, `objectiveai-laboratory/`,
`objectiveai-mcp-laboratory/README.md`, `.agents/skills/script-agents/SKILL.md`.

---

## 1. The one-sentence version

> **The Swarm Harness.** Define and compose swarms of LLM agents. Spawn an agent
> to do things, spawn a swarm to score things, or hand a swarm a Docker sandbox.

The internal framing in `CLAUDE.md` is sharper and more useful: *"an agentic
collective judgment harness. It uses scoring, ranking, and simulation across
swarms of agents to produce collective judgments that can be easily fine-tuned."*

**Judgment is the product.** Phosphene is a design tool, but the half of it that
is *native* to this platform is the judging half. That is worth sitting with
before §6 decides what phosphene should be.

---

## 2. The primitive that matters most, and why

### The core claim

> A single language model asked to score something hands back one sampled token
> and walks away from everything else it computed. The signal it had — how
> confident it really was, where it hedged, what it nearly chose instead — never
> leaves the model.

ObjectiveAI bypasses the sampler. Each agent contributes a **preference
distribution** over the candidates, read from **logprobs**, rather than a single
sampled choice. Those distributions combine under weights into a score vector
that sums to 1. No discrete collapse.

This matters twice: once per model (distribution, not a token) and once across
models (different failure modes, different training distributions — combining
under weights beats picking the single best-average model).

### The prefix tree

`pfx.rs` in `objectiveai-api` structures candidate responses around the logprobs
limit. Tree width matches the number of logprobs returned (typically 20), so
voting works over hundreds of options while preserving probability at each level.
Large sets use nested prefixes (`` `A` ``, `` `B` ``) to capture preference in
stages.

**Consequence for phosphene:** the number of things being scored in one vector
completion is not a free parameter — it interacts with a real mechanism. Worth
understanding before designing a review that scores N designs × M dimensions.

---

## 3. The type system

Two **resources** and two **execution modes** — but there are also **Functions**
and **Profiles**, which the README's "Core primitives" section omits entirely and
`CLAUDE.md` covers. **This is the layer phosphene's review actually runs on**, so
the omission matters: reading only the README would leave you building on a
substrate you have never seen described.

### Agent

A fully-specified configuration of one upstream model: model identity, prompt
structure, decoding parameters, output mode, tools, MCP servers, provider
preferences.

- **Content-addressed** via XXHash3-128 → a deterministic 22-character base62 ID.
- Hashed *after normalization* (empty fields stripped, defaults canonicalized), so
  **two agents with identical effective settings are the same agent.**
- Stored as `agent.json` in a git repo; referenced as `(owner, repository, commit)`.
- Each upstream (OpenRouter, Claude Agent SDK, Codex SDK) has its own agent type
  with its own parameter set.

### Swarm

An ordered collection of agents used together to score collectively.

- Immutable, content-addressed from the sorted `(full_id, count)` pairs.
- **Weights are NOT in the swarm.** They are execution-time parameters. The same
  swarm can be reused under different weights without becoming a new swarm.
- Each slot has a `count` and optional fallbacks. Duplicates merge, counts sum.
- **Total agent count across all slots: 1–128.**
- Stored as `swarm.json`.

### Function

**Composable scoring pipelines. Data in → score(s) out.** A function executes a
list of **tasks**, where each task is either a vector completion or another
function. It produces either:

- **Scalar** — a single score in `[0, 1]`
- **Vector** — an array of scores summing to ≈ 1

The function's final output is the **weighted average of all task outputs, using
profile weights.**

### Profile

**Learned weights for a function.** ObjectiveAI does not fine-tune models; it
learns optimal weights over fixed agents. Training takes a dataset of inputs and
expected outputs, executes repeatedly, computes loss, and adjusts weights.

Stored as `profile.json`, GitHub-hosted. The docs explicitly recommend pinning a
commit SHA *"since the profile's shape may change in future versions."*

### The resource graph

Everything references everything else by `(owner, repository, commit)`. Remote
references resolve lazily — the retrieval system walks the graph from the request,
fetching and caching each resource exactly once, deduplicated by triple. All
fetches are content-verified; a cached resource is never re-fetched when the SHA
matches.

---

## 4. The expression system

`CLAUDE.md` calls this *"the most complex part of the SDK."* Two languages:

- **JMESPath** — `{"$jmespath": "input.count < \`10\`"}`
- **Starlark** — `{"$starlark": "output['scores'][0]"}` (Python-like, not
  Turing-complete)

### Per-task expressions

| Field | Meaning |
|---|---|
| `skip` | Boolean. If true, the task is skipped. |
| `map` | Evaluates to a **count** (integer), creating that many task instances. **Each instance receives `map` as a 0-based index — NOT the element itself.** Use the index to look up data from the input. |
| `input` | Defines the task's input from the function input and map context. |
| `output` | Transforms the task's raw result into a `FunctionOutput`. |

### Expression context

- `input` — the original function input
- `map` — the current map index (mapped task context only)
- `output` — the raw task result (task output expressions only)

### `input_split` / `input_merge` — read this one carefully

Vector functions carry `input_split` and `input_merge` expressions **for Swiss
System tournament-style execution**:

- `input_split` splits input into N sub-inputs, one per pool
- `input_merge` recombines them after scoring

**This is the origin of the `split_index` field that the old phosphene lost every
score to** (commit `360576f`, "Fix swarm review scores collapsing to 0.5 (dropped
split_index)"). The old app was reading a wire field whose *semantics it had never
seen documented*, because it reverse-engineered the shape from live CLI output.
The mechanism is a pooled tournament; the index identifies which pool a result
belongs to. Anything phosphene does with split results should be designed against
this section, not against observed JSON.

### Output constraints

- Each task's output must be valid for the parent function's type.
- Scalar functions: task outputs in `[0, 1]`.
- Vector functions: task outputs sum ≈ 1, and match `output_length` if specified.

---

## 5. Streaming — the architecture phosphene should stop reimplementing

`objectiveai-api/CLAUDE.md` describes a **stream-first, zero-collect** design.
Four layers, each wrapping the one below and yielding immediately:

```
Layer 4: Function Executions  → FunctionExecutionChunk
Layer 3: Vector Completions   → VectorCompletionChunk
Layer 2: Agent Completions    → AgentCompletionChunk (+ Continuation)
Layer 1: Upstream Clients     → AgentCompletionChunk (+ upstream State)
```

Three properties that matter directly to phosphene:

**Scores converge in real time, by design.** The vector client uses a *one-ahead
buffer*: it updates running weights and scores from each vote as it arrives and
**attaches cumulative scores to every outgoing chunk**. From `CLAUDE.md`: *"The
consumer sees scores converge in real time as votes arrive."* The old app built
progressive partial reviews by hand, throttled at 16 ms, on top of a stream that
was already doing this.

**The first-chunk contract.** At every layer: *"If the first item would be an
error, `create()` returns `Err(...)` instead of yielding an error chunk."* Also:
no empty streams — an upstream producing zero chunks must return `Err`. So a
leading failure is a rejected promise, never a stream item. **A caller does not
need to defensively inspect the first chunk for errors.**

**Usage arrives after the stream ends,** via `create_streaming_handle_usage()` —
aggregation runs in a background task and the `UsageHandler` fires exactly once
after the stream closes. Cost is not available mid-stream, and that is deliberate,
not a bug to work around.

---

## 6. The error taxonomy — fatal vs. advisory, from the source

`ERRORS.md` enumerates every error path in a function execution. The critical
structure, which the old app approximated with a hand-rolled `classifyStreamError`:

| Class | Behavior | Examples |
|---|---|---|
| **§1–2 Pre-execution** | **Terminate the stream before any chunk.** Surface as `Err(...)`. | `FunctionNotFound` (404), `ProfileNotFound` (404), `InputSchemaMismatch` (400), `InvalidProfile` (weights/tasks length mismatch), `InvalidSwarm`, `SwarmNotFound`/`FetchSwarm`, `InvalidAppExpression` at compile, `InvalidFunctionForStrategy`, `InvalidStrategy` (Swiss `pool <= 1` or `rounds == 0`) |
| **§3 Vector completion** | **Caught gracefully — an error chunk, stream continues.** | A VC task's stream fails to create; an agent errors mid-stream (surfaces as an error field on the `VectorCompletionChunk`) |
| **§4 Task output expression** | **Accumulated, reported in the final chunk.** | `InvalidScalarOutput` (out of `[-0.01, 1.01]`), `InvalidVectorOutput` (sum outside `[0.99, 1.01]`, or length ≠ `output_length`), aggregated as `TaskOutputExpressionErrors` |
| **§5 Swiss subsequent rounds** | **Non-fatal — execution completes, error in the final chunk.** | `input_merge` failure in round > 1 |
| **§6 Reasoning** | Error chunk in the reasoning stream. | The reasoning agent fails |

Two details worth keeping:

- **Tolerances are explicit.** Scalar `[-0.01, 1.01]`; vector sum `[0.99, 1.01]`.
  These are the platform's own numbers — do not invent different ones.
- **`NoValidTaskOutputs` is dead code.** Defined in `error.rs`, never generated;
  `compute_weighted_function_output` returns `TaskOutputOwned::Err { error: null }`
  instead.

---

## 7. Agent completions: continuation

A `Continuation` carries conversation state between successive `create_streaming`
calls, as three item kinds: `State` (upstream-specific), `UserMessage`,
`ToolMessage`.

**The rule that will bite:** `params.messages` is **fixed**. Once set for the
first call, it must not change across subsequent calls in the same conversation.
New user turns — step prompts, retry prompts — go onto the *continuation* as
`UserMessage` items, not into `messages`.

Tool calls are detected mid-stream and executed automatically; attached MCP
servers are dialed transparently.

---

## 8. What a plugin is, per the README

The README's framing is **MCP-server-first**, and it differs in emphasis from the
viewer scaffold's:

> A plugin extends ObjectiveAI with **tools an agent can call**, and *optionally*
> with UI in the viewer. It is a **container**: an MCP server built from a
> `Containerfile` in your repository, run as an ephemeral laboratory container for
> the completion that uses it. A plugin may **also** ship a viewer half.

An agent uses a plugin by declaring coordinates:
`{ "plugins": [{ "owner": "you", "name": "my-plugin", "version": "v0.1.0" }] }`.
The laboratory host fetches that repo at the `v`-prefixed tag, builds the image,
and starts a container per completion. Tools arrive at the agent prefixed with the
server name — `greet` becomes `my-plugin_greet`.

**This reframes the viewer-only question.** The README treats the viewer half as
an optional adjunct to a tools plugin. The Rust manifest and the viewer scaffold
both explicitly support viewer-only (`mcp: Option<Mcp>`, *"ABSENT = a viewer-only
plugin"*). Both are true — but a viewer-only plugin is off the README's main path,
and phosphene would be the only one. That is a §6 input, not a blocker.

The README also documents the **full plugin system**: `scaffold.sh`, the manifest
field table, the development registration loop, and the release ritual (tag
`vX.Y.Z`, push, delete the registrations).

### First-party plugins, and what they are for

`psychological-operations` (persona agents on X/Discord with scored ingestion),
`mundus-animarum` (persistent self-authored "souls" — a KV store keyed by an
agent's content-addressed ID), `arcanum` (skills for agents),
`quas-wex-exort` (programmatic MCP/CLI invocation from inside an agent, including
background tasks). All four are **agent-facing tool servers.** None is a
human-facing application in the way phosphene is.

---

## 8a. Laboratories — the piece nothing defined

Named constantly (`objectiveai laboratories spawn` is a prerequisite for plugin
development) but never defined in prose. From
`objectiveai-laboratory/src/main.rs`'s module doc:

> `objectiveai-laboratory` — **THE resident laboratory host for one (machine,
> state).** No subcommands: the binary IS the host, and the laboratory works
> entirely over WebSocket. The daemon is its sole spawner and holds its pipes […]
> serves MCP + transfer + create/delete requests for ALL of the state's
> laboratories until killed.

So: **a long-lived per-machine host process that runs podman containers on
demand.** The daemon spawns it and feeds it a declarative dial list over stdin.
Containers start lazily on first routed op and are *stopped* (never removed) on
graceful shutdown. It reads **no environment variables** by design; argv is
layout-only.

Its modules name the whole plugin build path: `plugin_manifest.rs`,
`plugin_image.rs`, `viewer_build.rs`, `podman/`, `db_proxy.rs`, `channel.rs`,
`transfer.rs`.

**It requires podman.** That is a real prerequisite for the release path, and
`podman/install.rs` suggests it may install podman itself — to confirm in Pass 3.

### `viewer_build.rs` — the authoritative build contract

Read now because it decides CI. One build =

> fetch the plugin repo at its version's git tag → `podman build` the manifest's
> `viewer.containerfile` with **that file's own directory as the context** → copy
> `viewer.output`'s contents out of the resulting image into the fixed
> `VIEWER_DIR` → pack them with the manifest → hand the daemon a drain handle.

**The image is never run.** All work happens in `RUN` steps at image-build time;
the host creates a container only to `podman cp` the output, then removes both
container and image. Only the plugin's cached base image survives.

Two things worth pinning down now:

- **`validate_output` (line 207) is the release gate.** It checks that every tab
  `module`, every declared `style`, every `script.module`, and the `icon` is
  actually a file in the copied output — *"caught HERE, where the author sees it,
  not as an unstyled tab."* **This is exactly the check the plan's §7 wants in
  CI, and now I have its precise semantics rather than a guess.**
- **The React-external invariant is NOT enforced by the host.** Verbatim: *"Because
  the plugin owns its toolchain, the ONE invariant we cannot enforce is the
  author's: react and its subpath specifiers must be left external."* So nothing
  upstream will catch a bundled React — it fails at runtime, on the first hook.
  **That check has to be ours.** This upgrades the plan's §7 "assert the externals
  in CI" from good practice to the only defense that exists.

---

## 9. Corrections to prior research

Reading HEAD directly contradicts three things I recorded in the plan's §3. Per
the plan's own test — *"a good pass contradicts something in §3"* — here they are:

1. **"No `docs/`, no `PLUGINS.md`, so the authoring guide *is* the scaffold."**
   Wrong emphasis. The root `README.md` has a full **Plugins** section (lines
   418–517): what a plugin is, `scaffold.sh` usage, a complete manifest field
   table, the development loop, and the release ritual. It is the best single
   plugin document that exists. I under-weighted it because it isn't a
   plugin-specific file.

2. **"The viewer surfaces plugin UIs as sandboxed iframe tabs."** This phrase is
   in the README (line 100) and it is **stale**. The implementation is one Tauri
   child webview per tab, plus native CEF windows for browser tabs — no iframes,
   no `sandbox=` attribute anywhere in the plugin path. *The README is wrong here,
   not the code.* Worth remembering that this repo's prose can lag its Rust.

3. **The README's "Core primitives" omits Functions and Profiles entirely** —
   it presents two resources and two execution modes. Functions, Profiles, and the
   whole expression system live only in `CLAUDE.md`. Since function execution is
   the layer phosphene's review runs on, anyone onboarding from the README alone
   would build on an undocumented substrate. That is very likely part of how the
   old app ended up reverse-engineering wire shapes.

Additionally: `objectiveai-daemon/README.md` is **not** a daemon README — it is a
copy of the CLI README, with the heading `# objectiveai-cli`. Do not cite it for
daemon behavior.

---

## 10. What this changes for phosphene

Recorded as findings, not decisions. §6 owns the decisions.

1. **Phosphene's judging half is the platform-native half.** Vector completions
   and functions exist precisely to score candidates. The generation half is
   ordinary agent completions that any tool could do.
2. **Stop hand-building what the stream already does.** Cumulative scores are
   attached to every chunk. Leading errors are rejections, not chunks. There is a
   documented fatal/advisory split. Three hand-rolled mechanisms in the old app
   have upstream equivalents.
3. **Functions + Profiles are a designed authoring surface, and the old app never
   used it as one** — it built function and profile objects inline, at runtime,
   from TypeScript. Functions and profiles are meant to be **git-hosted,
   content-addressed, commit-pinned, and trainable**. A phosphene whose review
   function lives in a repo and whose weights are a *learned profile* is a
   materially different — and more platform-native — product than one that
   assembles a function literal per request. **This is the single biggest open
   product question, and it belongs in §6.**
4. **`input_split` / `input_merge` are Swiss-System pooling.** Design against the
   documented mechanism, never against observed JSON.
5. **Cost is only available after a stream ends.** A live per-chunk cost meter is
   not something the platform offers; the old app's char-count estimator was
   filling a gap that exists by design.

---

## 11. Open questions carried into later passes

- What is the **`functions` CLI command group's** full surface, and what does
  `functionsExecuteStandardExecuteStreaming` vs. `…SwissSystem…` actually take?
  → **Pass 3.**
- How are functions and profiles **authored and published** — is there a template
  repo (`objectiveai-function-template`, `objectiveai-function-sandbox`, and the
  five `profile-*` repos exist in the org)? → **Pass 3 / follow-up.**
- What does **training a profile** require in practice? → deferred; relevant only
  if §6 chooses the git-hosted-function direction.
- **Channels** — named throughout (`channel_key` handlers, `channels` CLI group,
  `laboratory/src/channel.rs`), still undefined. → **Pass 3.**
- Does the laboratory **install podman itself** (`podman/install.rs`), or is it a
  prerequisite the author must satisfy? Decides how heavy the release path is.
  → **Pass 3.**
- What are the **five `profile-*` org repos** (nano, mini, standard, giga,
  giga-max)? The README calls them "official standard profiles for an ObjectiveAI
  Function" — these may be exactly what phosphene's review should reference
  instead of hand-building weights. → **follow-up.**
