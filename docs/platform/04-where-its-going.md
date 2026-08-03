# Pass 5 — where the platform is going

**Read at:** `ObjectiveAI/objectiveai@649b1d7cf2976036ddcec11d8be1001880d2ca87`
(HEAD, 2026-08-01 — our own PR [#302](https://github.com/ObjectiveAI/objectiveai/issues/302)) — 2026-08-02.

**Why this pass exists.** Ronald told Maya four things: ObjectiveAI is no longer
selling on logprobs and vote distribution; it is a distributed agent harness with
tools in the agents; it is going P2P; and functions are out. Pass 4
(`03-changelog.md`) read trajectory as of 2026-07-30 and is now a week stale on
the only axis that matters. This pass checks all four claims against source.

**Sources read in full:** issues [#301](https://github.com/ObjectiveAI/objectiveai/issues/301), [#298](https://github.com/ObjectiveAI/objectiveai/issues/298), [#299](https://github.com/ObjectiveAI/objectiveai/issues/299), [#287](https://github.com/ObjectiveAI/objectiveai/issues/287), [#281](https://github.com/ObjectiveAI/objectiveai/issues/281), [#171](https://github.com/ObjectiveAI/objectiveai/issues/171); the root
`README.md` (633 lines); the open-issue list; every commit since 2026-08-01.

---

## 1. The four claims, checked

| Claim | Verdict | Evidence |
|---|---|---|
| **Functions are out** | **Confirmed, and already acted on.** | Ronald direct, 2026-08-01. Recorded in HANDOFF §ARCHITECTURE CHANGED; phosphene has used agent completions only since. |
| **P2P** | **Confirmed as direction, unspecified as design.** | [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) (2026-07-31). |
| **Distributed agent harness, tools in the agents** | **Confirmed.** | Agent `plugins: []` grants tools (`agent/plugin.rs`); [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) turns upstreams into containers; [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) makes peers both ask for and do work. |
| **No longer selling on logprobs / vote distribution** | **Confirmed as intent — but the repo has not caught up.** | See §4. This is the one finding that changes our recorded conclusions. |

**One nuance worth keeping straight, because it is easy to blur:** *swarm* and
*logprobs* are not the same thing. A swarm is N configured agents scoring
collectively. Logprob voting is the *mechanism* by which a vector completion reads
each agent's preference distribution instead of its sampled token. The first is
alive and is still the README's headline. The second is what is being
de-emphasized.

---

## 2. [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) — containerize agent upstreams. The real structural change.

Not P2P. **This** is the change that reorganizes everything else.

Today an upstream is a Rust type implementing `UpstreamClient<AGENT, CONTINUATION>`
compiled into `objectiveai-api`. There are five: openrouter, claude_agent_sdk,
codex_sdk, script, mock. Each costs a type parameter threaded through three
clients, a definition surface in five places plus a module per SDK per language,
and a release coupling — "a new upstream ships only when the api server ships."

The change: **one ObjectiveAI-defined API spec that an upstream container
implements.** "The api server stops knowing what an upstream *is*; it knows how to
talk to one."

Two consequences land directly on phosphene, and both are load-bearing:

### 2a. The reverse-attach special case is being REMOVED

> "Script agents run Python on the *client* today, over the per-request
> reverse-attach websocket. In the containerized model they are simply a container
> with Python in it — the same mechanism as every other upstream, rather than a
> bespoke reverse-RPC path. **That removes the reverse-attach special case from
> the upstream contract entirely.**"

Our current plan's single unsettled gate is
`objectiveai-api/src/agent/completions/client.rs:1044-1057` — an agent declaring
`plugins` needs a reverse-attached WebSocket CLI or fails
`ClientObjectiveaiMcpUnavailable`. **That is the exact machinery [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) dissolves.**

So the gate is real *today* and must still be tested, but it is scheduled
scaffolding, not bedrock. Do not design around it permanently.

### 2b. Script-agent fan-out sits on replaced machinery

Phosphene's verified scoring design — a script agent fanning out N judges via
`objectiveai.execute(argvs)`, proven twice against the log tier — is exactly the
"bespoke reverse-RPC path" [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) names for removal. The *capability* survives (a
Python container can still spawn agents); the *mechanism* changes.

Verdict: keep the design, expect to re-plumb it. Do not write more code against
`objectiveai.execute` than the feature needs.

### 2c. Tool calling is explicitly open

> "**Tool calling.** An upstream is handed a live, initialized MCP connection today
> and sources its own tool list from it. A container needs to reach the proxy over
> the network instead."

Listed under **Open**, with the db-proxy conduit named as the closest precedent.
So the transport by which an agent reaches plugin tools is not settled upstream.
The *contract* (`plugins: []` → prefixed tool names) is stable; the plumbing is not.

### 2d. The laboratory gets MORE central, not less

> "Client-side runs through the laboratory system. That machinery already exists
> and already does this shape of work… An upstream container is another tenant of
> it. **Server-side is TBD.**"

This is good news for our Phase 0. Standing up podman + a laboratory host is not a
detour that a future refactor deletes — it is the substrate everything is moving
onto.

---

## 3. [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) — P2P. Direction confirmed, design explicitly unknown.

**Read this issue with its own warning attached.** It was filed by a previous
Claude at Ronald's direction and says so in the first line:

> "Ronald has a plan here that I have not been told in full — this is a
> placeholder for the direction, not a specification of it. Everything below the
> first section is my guessing, and should be read as such."

**What is asserted:** make ObjectiveAI peer-to-peer; consolidate `objectiveai-api`
and `objectiveai-laboratory` into a new `objectiveai-provider`.

**Everything else in that issue is a guess**, including the reading that "every
install can both ask for work and do work." Do not cite it as fact — we have made
that mistake in the other direction before.

One guess is worth noting anyway because it aligns with our own product:
"Collective judgment is embarrassingly distributable. A swarm is N independent
agents voting. There is no reason those N have to be on one machine." If that
holds, phosphene's judgment feature is a natural fit for where the platform is
going rather than a legacy of where it was.

**Explicitly unknown, per the issue itself:** whether peers discover or are
configured; what makes a peer's returned vote trustworthy; whether payment is
involved; whether `objectiveai-provider` replaces both crates; whether the hosted
API stays a peer or something else.

---

## 4. Logprobs: intent has moved, the repo has not

This needs stating precisely, because the evidence points two ways.

**The README at HEAD still sells logprobs as the core differentiator**
(`README.md:70`, `:82`, `:222`, `:224`):

> "Each agent in a swarm contributes a preference distribution over the candidates
> rather than a single sampled token… No discrete collapse. No lost signal."

Plus the prefix-tree machinery "structured around the logprobs limit" for scoring
hundreds of candidates. The execution-modes table still presents vector completions
as a first-class mode returning "a calibrated, multi-model score."

**But nothing on the roadmap invests in it.** Searching every issue for
vector/swarm/logprob returns no proposal to extend, fix, or promote vector
completions. Every open structural issue — [#298](https://github.com/ObjectiveAI/objectiveai/issues/298), [#299](https://github.com/ObjectiveAI/objectiveai/issues/299), [#300](https://github.com/ObjectiveAI/objectiveai/issues/300), [#301](https://github.com/ObjectiveAI/objectiveai/issues/301), [#296](https://github.com/ObjectiveAI/objectiveai/issues/296) — is about
agents, tools, containers, upstreams, placement. [#250](https://github.com/ObjectiveAI/objectiveai/issues/250) ("public deep-dive — how the
swarm actually works") is closed. And [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) lists `vector::completions::Client` only
as one of three places a per-upstream generic has to be threaded — i.e. as cost.

**Synthesis:** vector completions are not being removed, and no source says they
are. They are simply no longer where the work or the pitch is going. Ronald's
statement is ahead of the README, which is the old pitch not yet rewritten.

### What this reverses for us

HANDOFF records losing logprobs as *"a real downgrade, and it is the platform's
headline feature."* **Both halves of that sentence are now wrong.**

- It is not the headline feature any more.
- Therefore scoring as N discrete agent completions is not a downgrade — it is
  alignment.

This also drains the significance of a fact we spent real effort establishing:
that a plugin can never do a vector completion (`#[cfg(feature = "http")]`-gated
out of plugin binaries). True, still. It just no longer costs us anything.

**And our own measurement already agreed.** The 4-model swarm run was 7 of 8 votes
one-hot. The signal came from model diversity, not distributions. We wrote that
down as a curiosity; it was actually the platform's direction showing up in our
data.

---

## 5. [#171](https://github.com/ObjectiveAI/objectiveai/issues/171) — the viewer's own roadmap points where we do

Open since 2026-04-28, umbrella RFC:

> "Turn objectiveai-viewer into a GUI swarm orchestrator… Today the viewer is a
> passive monitor. The vision is a **two-headed orchestrator** — a coding agent
> drives work through the CLI, a human drives the same work through the viewer,
> both surfaces see the same state in real time… The viewer becomes 'pretty for
> the human user' — visually rich, dense with detail, designed for sustained human
> attention."

That is phosphene's thesis in the platform's own words, and it independently
corroborates Pass 3 §7's archetype ("the viewer half is the human end of an
agent's workflow"). It is the strongest evidence yet that the inversion in our
plan — tab as display, agent as orchestrator — is the intended shape and not just
Ronald's preference.

---

## 6. [#287](https://github.com/ObjectiveAI/objectiveai/issues/287) / [#281](https://github.com/ObjectiveAI/objectiveai/issues/281) — two smaller things that change the plan

**[#287](https://github.com/ObjectiveAI/objectiveai/issues/287) — the MCP half will not be Rust-only.** `objectiveai-mcp-plugin-scaffold-js`
is planned (blocked on [#278](https://github.com/ObjectiveAI/objectiveai/issues/278), the JS framework), alongside Go ([#288](https://github.com/ObjectiveAI/objectiveai/issues/288)) and Python
([#289](https://github.com/ObjectiveAI/objectiveai/issues/289)). It also states the boundary cleanly: "a viewer plugin is always JS and
produces browser assets, while this produces a container that serves MCP. A plugin
may have both, and **they share nothing but the manifest**."

Consequence for us: our plan writes the MCP half in Rust because that is the only
attested option at HEAD. If [#278](https://github.com/ObjectiveAI/objectiveai/issues/278)/#287 land first, phosphene could write both halves
in TypeScript and share the prompt constants instead of porting them. Worth
checking before starting Phase 2 — it would remove the single largest chunk of work
in the plan.

**[#281](https://github.com/ObjectiveAI/objectiveai/issues/281) — plugin whitelist, default-deny.** Today "referencing a plugin is all it
takes to run one… That's arbitrary code execution by reference." The fix: durable
per-user whitelist, explicit sign-off on first encounter, approval keyed on the
identity trio. When this lands, a phosphene user gets a consent prompt before the
MCP half ever runs. Design the first-run experience expecting it.

---

## 7. Corrections to prior research

1. **HANDOFF: "no logprobs is a real downgrade, and it is the platform's headline
   feature."** Wrong on both counts as of 2026-08-02. See §4.
2. **The plan's Phase 0 gate is temporary, not permanent.** The reverse-attach
   requirement is named for removal in [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) §"Script agents". Test it, do not
   architect around it.
3. **Pass 4 (`03-changelog.md`) read [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) as the newest signal.** [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) is the more
   consequential issue and was under-weighted — it is the one that reorganizes
   upstreams, script agents, and tool transport.
4. **"The MCP half must be Rust"** is true at HEAD but is a stated-temporary
   condition ([#287](https://github.com/ObjectiveAI/objectiveai/issues/287)/#288/#289), not a platform property.

---

## 8. Unsettled from source

- **The whole of P2P's design.** [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) says so itself. Anything more specific than
  "api + laboratory consolidate into `objectiveai-provider`, peers both request and
  perform work" is a guess, including the guesses inside [#301](https://github.com/ObjectiveAI/objectiveai/issues/301).
- **Whether vector completions survive the provider consolidation.** No issue says
  they go; none invests in them. Unknowable from source today.
- **Timing.** No milestones, no dates, no assignee on [#298](https://github.com/ObjectiveAI/objectiveai/issues/298) or [#301](https://github.com/ObjectiveAI/objectiveai/issues/301). Whether these
  land in weeks or months determines whether phosphene should wait — and it cannot
  be read off the repo. **This is a question for Ronald, not for research.**
