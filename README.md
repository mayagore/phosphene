# phosphene

Design exploration and judgment, as an ObjectiveAI plugin. Describe a brief;
an agent invents contrasting design directions, renders them across shared
states, and — when you name judge models — scores them with a multi-model
panel whose disagreement is shown, never averaged.

A plugin is a set of tools. Phosphene's six are `invent_directions`,
`render_state`, `refine_state`, `score_direction`, `get_exploration` and
`get_state`, served by the MCP half; the viewer half is a tab that watches your
agent use them.

## Using it

An agent reaches the tools by declaring the plugin:

```json
{ "plugins": [{ "owner": "mayagore", "name": "phosphene", "version": "v0.1.0" }] }
```

There is no registry and no install step — the laboratory host fetches
`github.com/mayagore/phosphene` at that tag, builds it, and runs it. To use the
tab instead, register both halves locally (see Quick start below).

**What a run is.** You type a brief in one composer. The agent invents 3
contrasting directions, picks 3 states that suit the brief, and renders all 9
as self-contained 400×720 documents onto a canvas you can pan, zoom and export.
Name judge models in your brief and each direction is scored on four dimensions
by each judge separately — the spread between judges is the point, so scores
are never averaged. Then you can refine: give feedback in plain words and the
affected cells are revised in place. Expect **10–30 minutes** for a full
exploration; renders are serial.

**Prerequisites, all of them.** Two are easy to miss and both look like
phosphene bugs when they bite:

| | |
|---|---|
| ObjectiveAI CLI **≥ 2.2.15** | Earlier releases cannot render *any* plugin tab. |
| podman machine with **≥ 6 GiB** | The default 2 GiB OOM-kills the MCP half's Rust build, and the SIGKILL surfaces as an unrelated MCP 502. |
| A live local **`claude` login** on the daemon host | Invention and rendering run on `claude_agent_sdk` — free and denser than the metered alternative, but it needs the machine's own Claude Code login. A lapsed login is reported by the platform as the nonsense string `"Claude Code returned an error result: success"`. |
| **MCP timeout env on the daemon**, exported *before* it starts | `MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`, `MAX_MCP_OUTPUT_TOKENS`. Without them claude's MCP client kills any tool call silent for 60s — which is essentially every render — and orphans the nested completion. `scripts/resume.sh` exports these for you; a daemon started any other way must be killed and respawned through it. This one is a platform limitation a plugin cannot fix from its side. |

Judging costs money — judges run on OpenRouter, one completion per
(direction × judge). Invention and rendering do not, on the Claude login.
Phosphene does not meter spend for you yet.

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
ObjectiveAI CLI ≥ 2.2.15 on PATH, and a podman machine with **≥ 6 GiB**
memory (the default 2 GiB OOM-kills the MCP half's Rust build — see
`docs/spikes/02-plugin-authoring.md` §2).

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
--version v0.1.0` after an edit.

The tab reports its own health to the viewer's log inbox on boot
(`phosphene: ready · daemon round trip Nms`). If the tab is blank, look there
first — `~/.objectiveai/state/default/viewer/viewer-logs/`.

## Layout

Both halves under one manifest, exactly as `scaffold.sh` emits:

```
objectiveai.json   the ONE manifest — both halves, at the root
mcp/               the MCP server (Rust): the three tools an agent calls
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
| Where the platform is going | `docs/platform/04-where-its-going.md` |
| Agent identity & versioning | `docs/platform/05-agent-identity.md` |
| What building a plugin is like | `docs/spikes/02-plugin-authoring.md` |
| What we score and how | `docs/scoring.md` |
| The rebuild judged against all of the above | `docs/reviews/01-intention.md` |

`docs/` is maintained, not written once — when a decision reverses, the doc
that recorded it gets struck and dated, not silently rewritten.
