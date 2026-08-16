# phosphene

## First: find out when "now" is. No document here is dated.

```bash
git log -5 --format='%h %ad %s' --date=short && git tag -l
pgrep -fl objectiveai-daemon       # is one already up, and did resume.sh start it?
bash scripts/verify-claims.sh      # 26 checks, ~8s — but read the warning below FIRST
```

**⚠️ `verify-claims.sh` is read-only about the REPO but it is not free: running
any `objectiveai` command auto-spawns a daemon if none exists, and that daemon
comes up WITHOUT the MCP timeout env** (measured 2026-08-14: with no daemon
running, `--fast` left pid 5403 alive with zero `MCP_TOOL_TIMEOUT`). So it
creates exactly the landmine trap 2 below describes. Safe orders:

- Already working? `bash scripts/resume.sh` first, then verify freely.
- Just looking? Run it, then **kill the daemon it spawned** before anyone renders.

A cold session refused to run this file's own opening command because the docs
did not resolve that ambiguity. It was right to.

The newest commit is the last thing that happened. A document's own date only
says when someone last edited it, and this file, `HANDOFF.md` and the plan are
edited at different times by different sessions.

**You may be reading a stale copy of this file.** A session's auto-loaded
context can predate the working tree. If this file disagrees with `README.md` —
on the tool list, on anything — `git show HEAD:CLAUDE.md` wins. (Measured: a
cold session was handed a copy claiming three MCP tools when the repo had six,
and would have missed `refine_state` entirely.)

Run `verify-claims.sh` before believing anything below. It is eight seconds and
cheaper than any assumption it catches.

---

Design exploration and judgment, as an ObjectiveAI plugin.

**Two halves.** Seven MCP tools in Rust (`mcp/`) — `invent_directions`,
`render_state`, `refine_state`, `score_direction`, `list_explorations`,
`get_exploration`, `get_state`. A daemon-spawned agent calls them. The viewer
tab (`viewer/`) is a
**display** onto that agent's run and never does design work itself.

Boards live in the daemon's postgres, keyed by a caller-minted `exploration_id`
(a v4 uuid). That id **is** the capability — holding one grants read and write,
and a run outlives the tab that started it.

---

## Where this stands right now

**Shipped: v1.0.0, tagged 2026-08-16 on Maya's explicit order** ("if it works
tag and ping" — after the taste loop was confirmed both ways and a cold
end-to-end run passed at the v1.0.0 coordinates). The tag is permanent — the
image cache has no SHA pinning, so **v1.0.0 is never re-cut**; any change
ships as a new version, and the never-tag-without-Maya rule applies to every
future tag unchanged. (Her 2026-08-13 "keep exploring, don't tag yet" stood
until she reversed it herself.)

The live map is **`~/.claude/plans/ancient-bubbling-beacon.md`**. Read it before
planning work. `HANDOFF.md` is the durable record of how we got here, not the
plan.

**The product problem, and the result so far.** Outputs were formulaic. Giving
models better *materials* (a real font kit) changed nothing measurable —
compositional vocabulary went 3.44 → 3.44. Making them commit to a *decision*
(a named layout strategy, required, and the three must differ) moved it to 4.00
and made the three directions finally occupy different regions. **Telling a model
to decide beats giving it better supplies.** That is the working hypothesis.

---

## The four traps that will cost you a day

**1. The dev container does NOT rebuild on source change.** It reuses the cached
image whenever one exists, so a successful call proves the container *answers* —
not which build it is serving. After ANY `mcp/` change:

```bash
podman rmi -f localhost/objectiveai-plugin:mayagore-phosphene-v1.0.0
```

(Vendored podman: `~/.objectiveai/bin/podman/*/podman-*/usr/bin`, with
`CONTAINERS_HELPER_BINARY_DIR` set to it.) Verify the build is new by grepping
the run for new-prompt vocabulary, never by the call succeeding.

**`rmi` and `mcp reset` are not alternatives — do both, in this order.** They
clear different caches: `podman rmi` drops the built image, and
`objectiveai development plugins mcp reset --owner mayagore --name phosphene
--version v1.0.0` drops the daemon's registration state that otherwise takes an
image-exists fast path. Doing only one leaves the other stale. If `reset` fails
with "image is in use by a container", a plugin container outlived its run —
`podman stop` it (teardown is not guaranteed and `timeout_seconds` does not
reliably end a run); `scripts/agents-sweep.sh` covers recovery.

**2. Bring the stack up ONLY through `bash scripts/resume.sh`.** It exports
`MCP_TOOL_TIMEOUT`, `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` and
`MAX_MCP_OUTPUT_TOKENS` first. Without them claude's MCP client kills any tool
call silent for 60s — which is every render — and orphans the nested completion.
**A bare CLI read auto-spawns a daemon WITHOUT that env**, so check
`resume.sh --check` before trusting any run. Killing the daemon is sanctioned
(Ronald, 2026-08-10).

**3. Other Claude sessions share this working tree.** One checkout, one index,
one `.git` — no isolation. A `git checkout`, `stash`, `reset` or branch switch
by either session lands on the other mid-edit with no conflict marker. Agree who
owns which files before editing.

To find peers: `git worktree list`, `ps aux | grep objectiveai`, and
`git log -3` against the shared checkout. `ListAgents` / `SendMessage` work in a
main session but **`ListAgents` does not exist in a subagent context** — don't
plan around it.

**And a worktree-specific hazard:** `scripts/resume.sh` registers with
`--path "$REPO"` derived from the script's own location, but its `register()`
only checks whether the plugin *name* is listed, never the *path*. Run
`resume.sh` from a worktree while a main-checkout registration exists and it
prints `ok mcp registered` while silently serving **the other directory's
code**. Check `objectiveai development plugins mcp list` for the path, or delete
and re-create the registration deliberately.

**4. A spawn prints a PATH, not an instance.** `daemon/<leaf>` — the last segment
is the instance, everything before it is the parent. Passing the joined string
as `instance=` fabricates a target that never ran and the daemon **zero-fills**
it, which is where "the instruments lie" came from.

```bash
objectiveai agents logs list --target "instance=$LEAF,parent=daemon" --all
```

Exactly one of `--all` / `--pending` is required. `parent=` is absolute.

---

## Two rules that are not yours to break

- **Never `git tag`** until Maya says "we are at the level of done." The tag IS
  the release — no registry, no publish command — and the image cache is keyed
  on `(owner, name, version)` with no SHA pinning, so a re-cut tag ships
  different bits under one identity, permanently.
- **Never fabricate a design decision.** If a model returns no palette, no type
  choice or no composition, phosphene FAILS the direction rather than inventing
  one. It used to substitute a palette byte-identical to its own prompt example
  and then measure "adherence" against it. Show the failure.

## Everything is checkable — check it

ObjectiveAI's source is on this machine at `~/Programming/objectiveai`,
version-exact with the installed CLI:

```bash
objectiveai --version && git -C ~/Programming/objectiveai describe --tags
```

`objectiveai <leaf> request-schema` / `response-schema` carry the Rust doc
comments, so they are often faster than opening a file. Several recorded "the
instrument is broken" findings here turned out to be usage errors. **Prefer
running the command over believing a written claim — including a claim in this
file.**

Two ways we have fooled ourselves, both worth knowing: a grep window that starts
below the answer reports an absence as a finding, and a check that swallows an
error into an empty result (`2>/dev/null || echo 0`) reports "nothing happened"
when it means "I am not looking." Use `scripts/pg.sh` to reach postgres; it
resolves the port live and never reports a failure as a zero.

**Precedence:** `docs/spikes/`, `docs/platform/`, `docs/reviews/`, `docs/legacy/`
are records of what was observed on a date, not standing fact. Where one
disagrees with something verifiable, the verifiable thing wins. Supersede it
where the operative claim lives; do not edit the archived record.

---

## Where to look, by what you are doing

| doing | read |
|---|---|
| anything | the memory brain's `MEMORY.md` — it is an index, one line per topic |
| planning work | `~/.claude/plans/ancient-bubbling-beacon.md` |
| running it | `README.md` — dev loops, prerequisites, contracts that fail silently |
| touching agents | `.agents/skills/agent-control/SKILL.md` |
| scoring / rubric | `docs/scoring.md` |
| the UI | `docs/design.md`, and `design-legacy/` + Figma as the design source of truth |
| why any of this exists | `docs/why-rebuild.md` |
| checking our claims | `bash scripts/verify-claims.sh` — 26 checks, read-only, ~8s |

## Repos on this machine

- `~/Programming/phosphene` — **this repo**, the live rebuild.
- `~/phosphene` — `phosphene-legacy`, the shipped predecessor. Design reference
  only; it predates the two-halves architecture and is not a code reference.
- `~/Programming/objectiveai` — upstream source, above.

## Memory

Folder-keyed. A worktree under `.claude/worktrees/` gets its own key, so it does
NOT inherit the rulings in the memory files — which is why this file carries the
traps rather than pointing at them. (Measured 2026-08-14: a worktree session was
auto-loaded with this file *and* the brain's `MEMORY.md` index, but the index is
only pointers; assume the files behind them are unread.) The repo's brain is
`~/.claude/projects/-Users-maya-Programming-phosphene/memory/`; Maya-wide facts
live in the main brain at `-Users-maya-Desktop-work-claudecode/memory/`.
