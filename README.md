# phosphene

Design exploration and judgment, as an ObjectiveAI plugin. Describe a brief;
an agent invents contrasting design directions, renders them across shared
states, and — when you name judge models — scores them with a multi-model
panel whose disagreement is shown, never averaged.

A plugin is a set of tools. Phosphene's are `invent_directions`,
`render_state`, and `score_direction`, served by the MCP half; the viewer half
is a tab that watches your agent use them.

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
asserted by `pnpm run check:contracts` (five assertions, run in CI):

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
