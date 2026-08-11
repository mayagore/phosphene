# phosphene — orientation

Design exploration and judgment, as an ObjectiveAI plugin. Three MCP tools
(`invent_directions`, `render_state`, `score_direction`); a daemon-spawned agent
calls them; the viewer tab is a display onto that agent's run. The tab never
does design work itself.

`bash scripts/resume.sh` is the whole cold start; `--check` reports without
changing anything. `README.md` has the dev loops and the contracts that fail
silently.

## Read in this order

1. `README.md` — how to run it, and what fails silently.
2. `HANDOFF.md` — current state and next action.
3. `.agents/skills/<task>/SKILL.md` — task-shaped guides. `agent-control` is the
   one to read before touching agents. They live under `.agents/` rather than
   `.claude/` because daemon-side agents read them too.
4. Whichever of `docs/scoring.md` / `docs/design.md` / `docs/why-rebuild.md`
   covers what you are changing.

## Precedence — dated records are not current truth

`docs/spikes/`, `docs/platform/`, `docs/reviews/`, `docs/legacy/` are **records
of what was observed on a date**, not standing fact. Where one disagrees with
something you can verify by running a command or reading upstream source, the
verifiable thing wins. Do not edit an archived record to fix it — supersede it
where the operative claim lives, and leave the record alone.

## Platform behavior is checkable — check it

The ObjectiveAI source is on this machine at `~/Programming/objectiveai`,
version-exact with the installed CLI. Confirm before trusting it:

```bash
objectiveai --version && git -C ~/Programming/objectiveai describe --tags
```

- `objectiveai-sdk-rs/src/cli/command/agents/` — the command surface and types
- `objectiveai-daemon/src/command/agents/` — what the commands actually do
- `objectiveai agents <leaf> request-schema` / `response-schema` — the Rust doc
  comments carry into the schema descriptions, so this is self-documenting and
  often faster than opening a file

This matters because several recorded "the instrument is broken" findings in
this repo turned out to be usage errors. **Prefer running the command or reading
the source over believing a written claim** — including a claim in this file.

### The one that keeps costing time

A spawn prints a **path** — `daemon/<leaf>`. Split it: the last segment is the
instance, everything before it is the parent. Passing the joined string as
`instance=` fabricates a target that never ran, and the daemon **zero-fills** it
— which is where "the instruments lie" came from.

```bash
# RIGHT
objectiveai agents logs list --target "instance=$LEAF,parent=daemon" --all

# WRONG — exits 0, prints nothing, looks like a quiet agent
objectiveai agents logs list --target "instance=daemon/$LEAF" --all
```

Exactly one of `--all` / `--pending` is required. `--pending` shows only
unfinalized rows, so it is correctly empty for a run that has finished. `parent=`
is absolute; the CLI substitutes its own hierarchy only when `parent` is omitted.

## Repos on this machine

- `~/Programming/phosphene` — **this repo**, the live rebuild.
- `~/phosphene` — `phosphene-legacy`, the shipped predecessor. `design/` and the
  Figma file are still the design source of truth; it is **not** a code
  reference, since it predates the two-halves plugin architecture.
- `~/Programming/objectiveai` — upstream source, above.

## Memory

Session memory is folder-keyed, so a worktree under `.claude/worktrees/` starts
with an empty one and inherits its context from this file. The repo's brain is
`~/.claude/projects/-Users-maya-Programming-phosphene/memory/`; Maya-wide facts
live in the main brain at `-Users-maya-Desktop-work-claudecode/memory/`.
