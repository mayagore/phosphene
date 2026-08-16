# phosphene

Design exploration and judgment, as an ObjectiveAI plugin. Describe a brief;
an agent invents contrasting design directions, renders them across shared
states, and — when you name judge models — scores them with a multi-model
panel whose disagreement is shown, never averaged.

A plugin is a set of tools. Phosphene's seven are `invent_directions`,
`render_state`, `refine_state`, `score_direction`, `list_explorations`,
`get_exploration` and `get_state`, served by the MCP half; the viewer half is a
tab that watches your agent use them.

## Using it

> **v1.0.1 is the release** — cut 2026-08-16 after the taste loop was
> confirmed in production both ways and a cold end-to-end run passed at these
> coordinates. (v1.0.0 was cut and superseded the same day; declare v1.0.1.)
> A tag is frozen forever: the laboratory caches built images by
> `(owner, name, version)` with no SHA pinning, so a cut identity is never
> re-cut or reused — changes ship as a new version.

An agent reaches the tools by declaring the plugin:

```json
{ "plugins": [{ "owner": "mayagore", "name": "phosphene", "version": "v1.0.1" }] }
```

There is no registry and no install step — the laboratory host fetches
`github.com/mayagore/phosphene` at that tag, builds it, and runs it. To use the
tab instead, register both halves locally (see Quick start below).

**What a run is.** You type a brief in one composer. The agent invents 3
contrasting directions, picks 3 states that suit the brief, and renders all 9
as self-contained 400×720 documents onto a canvas you can pan, zoom and export.
Name judge models in your brief and each direction is scored on four dimensions
by each judge separately — the spread between judges is the point, so scores
are never averaged. When judges are named, the run closes its own loop once:
each direction whose notes name a concrete gap is refined against its harshest
note and re-judged — except directions whose declared composition argues
restraint, which are left alone (measured twice: refinement damages them).
Then you can refine further yourself: give feedback in plain words and the
affected cells are revised in place. Expect **10–30 minutes** for a full
exploration; renders are serial.

**Prerequisites, all of them.** Two are easy to miss and both look like
phosphene bugs when they bite:

| | |
|---|---|
| ObjectiveAI CLI **≥ 2.2.16** | Below 2.2.16, a daemon started without the MCP timeout env silently kills any render over 60s (2.2.16's runner defaults that env itself). Below 2.2.15, *no* plugin tab renders at all. |
| podman machine with **≥ 6 GiB** | The default 2 GiB OOM-kills the MCP half's Rust build, and the SIGKILL surfaces as an unrelated MCP 502. 2.2.16 sizes new machines to 6 GiB itself; a machine created by an older release needs `podman machine set --memory 6144` once, stopped. |
| **Your own Claude Code subscription**, signed in on the daemon host — **or** a declared upstream | Invention and rendering default to `claude_agent_sdk`, which runs on that machine's own `claude` login: free per run, and measurably denser (9,280 chars vs 6,179 on the same brief). This is a dependency on a subscription you hold separately, not something phosphene provides. **No login? Pass `upstream: "openrouter"` to `invent_directions` / `render_state` / `refine_state`** and it works without one — billed to your OpenRouter account, and a little thinner. Phosphene names a lapsed login for what it is; the platform below 2.2.16 reports it as `"Claude Code returned an error result: success"`. See the cost section below. |
| **MCP timeout env on the daemon** — automatic on ≥ 2.2.16 | `MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`. On ≥ 2.2.16 the runner sets these itself when the daemon's environment lacks them, so a bare `objectiveai` daemon is safe. `scripts/resume.sh` still exports them explicitly — operator env wins over the runner's defaults, and it keeps older daemons honest. |
| **Restart the daemon between long sessions** | A platform-side leak (measured on 2.2.16, reported upstream): each completion's nested `claude` process outlives its run and the runner keeps them registered, so after roughly five or six full explorations in one daemon session, renders degrade sharply — it looks like phosphene got slow, but it is the accumulated processes. Until the runner fix ships: stop the daemon and bring the stack back up (`scripts/resume.sh`), which clears them. Runs in progress survive a plugin-container stop, but not a daemon restart — finish or kill runs first. |

### What it costs, and what phosphene can and cannot tell you

**On the default seats, generation is free** — invention and rendering run on
`claude_agent_sdk`, which uses the daemon host's own Claude Code login. That
means the person running phosphene needs **their own Claude subscription**, and
must stay signed in on the machine running the daemon. It is the better output
(measured: 9,280 characters against 6,179 on the same brief) and it costs
nothing per run, but it is a dependency on a separate subscription and it is
worth knowing before you start rather than when a run fails.

**Judging always costs money**, and so does generation if you pass
`upstream: "openrouter"` — one completion per call, billed to your OpenRouter
account.

**Phosphene cannot show you that spend, and neither can the platform.**
Measured on 2.2.15: `agents spawn`'s response schema contains no `cost`,
`usage` or `token` field at all, and the one reporting surface that exists —
`objectiveai agents logs token-usage get --agent-instance-hierarchy <AIH>` —
returns only `total_tokens`, which is **`0`** for a `claude_agent_sdk` run that
produced nine full documents.

So phosphene shows you no per-run total and enforces no ceiling. It could
multiply a token count by a hardcoded price table and print a dollar figure,
and that figure would be invented — the same class of thing as the palette it
refuses to invent. **Watch your OpenRouter dashboard for real spend.** If you
want a hard cap, set one there, not here.

**If a direction comes back without a palette or a type choice, the run fails
and says so.** Phosphene does not invent design decisions on a model's behalf
to keep a run alive — you would be looking at colours nobody chose.

## Quick start

```bash
bash scripts/resume.sh
```

That is the whole cold start: daemon → laboratory host → **both** plugin
registrations → viewer, idempotent, every failure loud. `--check` reports
without changing anything. Prerequisites it manages or checks for you: the
ObjectiveAI CLI ≥ 2.2.16 on PATH, and a podman machine with **≥ 6 GiB**
memory (the default 2 GiB OOM-kills the MCP half's Rust build — see
`docs/spikes/02-plugin-authoring.md` §2; 2.2.16 sizes new machines itself).

Then, for development:

```bash
cd viewer && pnpm install && pnpm run dev    # watch build → viewer/dist
```

```bash
cd mcp && cargo test                         # the tool half
```

**The two dev loops are different.** The viewer half is picked up on tab
switch. The MCP half serves a **stale image silently** until you run
`objectiveai development plugins mcp reset --owner mayagore --name phosphene
--version v1.0.1` after an edit.

The tab reports its own health to the viewer's log inbox on boot
(`phosphene: ready · daemon round trip Nms`). If the tab is blank, look there
first — `~/.objectiveai/state/default/viewer/viewer-logs/`.

## Layout

Both halves under one manifest, exactly as `scaffold.sh` emits:

```
objectiveai.json   the ONE manifest — both halves, at the root
mcp/               the MCP server (Rust): the seven tools an agent calls
viewer/            the tab: build.mjs, src/, its own Containerfile
.agents/skills/    skills for coding agents working on this repo
scripts/resume.sh  cold start + re-registration (registrations die with the daemon)
docs/              platform research, spikes, decisions, reviews, legacy postmortem
```

## Identity

**Not in this repo's files.** Owner, name, and version come from the git tag
on release and from the `development plugins … create` registrations in
development. The **repo name is the plugin name on release** — an agent
declares `{owner, name, version}` and the laboratory host fetches
`github.com/<owner>/<name>` at the `v`-prefixed tag.

> A registration trio must match **byte for byte**, across both halves and
> any agent's declaration. `v0.1.0` ≠ `0.1.0`, and a mismatch is **silent** —
> it builds from GitHub as though nothing were registered.

> **Released tags are frozen forever.** The platform trusts but never
> verifies tag contents; changing tools under a shipped tag changes agent
> behaviour without changing agent identity. Any change after release —
> including a reworded tool description — is a new version.

## The contracts that bite

Failures that are **silent** if you get them wrong. The viewer-half ones are
asserted by `pnpm run check:contracts` (six assertions, run in CI):

1. **React external** — a tab bundle carrying its own React dies on the first
   hook with no useful error.
2. **Declared paths exist** in the built output, and **entry exports survive**
   — a stripped export renders a blank tab with no error.
3. **Registrations live in daemon memory** — a reboot drops them, and with
   the daemon down `plugins … list` returns empty rather than erroring, so
   "not running" and "not registered" look identical. `resume.sh` checks the
   process, not the output.

## Where the truth lives

| Question | Doc |
|---|---|
| Why this rebuild exists | `docs/why-rebuild.md` |
| What the platform is | `docs/platform/00-what-this-is.md` (see its banner) |
| The viewer host contract | `docs/platform/01-viewer.md` |
| The plugin contract | `docs/platform/02-plugin-contract.md` |
| What building a plugin is like | `docs/spikes/02-plugin-authoring.md` |
| What we score and how | `docs/scoring.md` |

`docs/` is maintained, not written once — when a decision reverses, the doc
that recorded it gets struck and dated, not silently rewritten.
