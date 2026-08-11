---
name: objectiveai
description: Running, inspecting, or debugging ObjectiveAI agents, plugins, the daemon, or the viewer from this repo — spawning an agent, reading what one did, registering or resetting a plugin half, or diagnosing a blank tab or a wedged run. Use whenever an `objectiveai` command is involved.
---

# ObjectiveAI, from phosphene

This is a router. The guides live under `.agents/skills/` because daemon-side
agents read them too; this file exists so Claude Code can find them.

## Pick the guide

- **`.agents/skills/agent-control/SKILL.md`** — spawn, message, wait, tags, and
  the `agents logs` tier. Read this before touching an agent.
- **`.agents/skills/script-agents/SKILL.md`** — authoring Python script agents.
- **`.agents/skills/mcp-plugin-development/SKILL.md`** — the Rust half: register,
  edit, reset. An edit does nothing until `plugins mcp reset`.
- **`.agents/skills/viewer-plugin-development/SKILL.md`** — the tab half.

## Before believing any claim

The ObjectiveAI source is on this machine at `~/Programming/objectiveai`,
version-exact with the installed CLI — confirm with
`objectiveai --version && git -C ~/Programming/objectiveai describe --tags`.
`objectiveai-daemon/src/command/agents/` is what the commands actually do, and
`objectiveai agents <leaf> request-schema` carries the Rust doc comments.

Several "the instrument is broken" findings recorded in this repo turned out to
be usage errors. Run the command or read the source rather than trusting prose,
including prose here. `CLAUDE.md` has the target-form trap that caused most of
them.
