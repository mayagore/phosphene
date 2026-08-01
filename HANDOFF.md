# Phosphene rebuild — handoff

**Paused:** 2026-07-31. Pick up from here in a new session.

## Where the new repo goes — DECIDED

**GitHub: `mayagore/phosphene`. Local: `~/Programming/phosphene`.**

Forced, not chosen: **the repo name is the plugin name on release.** An agent
declares `{owner, name, version}` and the laboratory host fetches
`github.com/<owner>/<name>` at the `v`-prefixed tag.

The old repo is **not deleted** — it moves aside:

1. ~~Rename `mayagore/phosphene` → `mayagore/phosphene-legacy`.~~
   **DONE 2026-07-31.**
2. ~~Repoint the local clone: `git -C ~/phosphene remote set-url origin
   https://github.com/mayagore/phosphene-legacy.git`.~~ **DONE 2026-07-31**,
   verified against `ee47aea`.
3. ~~Create `mayagore/phosphene` empty.~~ **DONE 2026-07-31** — public, no
   initial commit, so the scaffold's first commit lands clean.
4. Scaffold at `~/Programming/phosphene`; `git init`; point `origin` at
   `https://github.com/mayagore/phosphene.git`. **Not done.**
5. Move `~/phosphene-rebuild/docs/` in; retire the staging dir. **Not done.**

Locally `~/phosphene` stays put as reference, now tracking `phosphene-legacy`.

**Why step 2 mattered:** GitHub redirects `mayagore/phosphene` to the legacy repo
only until something else claims that name. The moment the new repo is created at
step 3 the redirect dies, and any clone still pointing at the old URL would
silently start talking to the new empty repo — which looks exactly like data
loss. That is now pre-empted.

## What this directory is

Staging for the rebuild's research artifacts **only** — not the future repo.
These docs move into `~/Programming/phosphene` at step 4 above.

```
docs/why-rebuild.md              the brief (Maya's words) — READ FIRST
docs/platform/00-what-this-is.md Pass 1 artifact — the platform, foundations
HANDOFF.md                       this file
```

The approved plan lives at
`/Users/maya/.claude/plans/we-will-need-to-elegant-truffle.md`.

## Where we are

| Phase | Status |
|---|---|
| Pass 0 — why we're rebuilding | **Done** → `docs/why-rebuild.md` |
| Pass 1 — purpose and foundations | **Done** → `docs/platform/00-what-this-is.md` |
| Pass 2 — the viewer | **Done** → `docs/platform/01-viewer.md` |
| Pass 3 — the plugin contract | **Done** → `docs/platform/02-plugin-contract.md` |
| Scaffold boot check | **Done — PASSES on v2.2.15** → `docs/spikes/00-boot-check.md` |
| Pass 4 — recency and trajectory | **Done** → `docs/platform/03-changelog.md` |
| Phase 1 — calibration spikes A–E | **Done** → `docs/spikes/01-calibration.md` (one gap: no provider key) |
| Phase 2 — decisions (§6) | Blocked on the above |

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
