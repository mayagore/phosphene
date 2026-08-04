# Review 01 — the rebuild against its intention

**Date:** 2026-08-03, at `19dc926` (main, clean, 18 commits unpushed).
**Method:** four independent adversarial reviewers, each against a different
intention source — the scaffold at `649b1d7` fetched fresh from GitHub, Ronald's
architecture directives, the product brief and legacy postmortem, and the
original plan's §7 engineering standards. Every finding below was then
**re-verified in this session against the actual files** (~21 direct spot-checks,
all passed; zero reviewer errors, zero findings discarded as false). The
2026-07 audit's lesson applied: no synthesis without checking what the reviewers
actually ran.

**Verdict, synthesized.** The *tree* is the most faithful instantiation of the
scaffold available, the work genuinely lives behind three tools in a
daemon-spawned agent, documents never transit the agent's context, and judgment
is N plain completions whose disagreement is never averaged. That is the hard
seventy percent, done right. The failing thirty percent clusters in exactly
three places: **the product's own nouns** (iteration does not exist; judgment
ships half-invisible), **the written record** (the repo's front-door documents
describe an architecture two commits reversed, and its shipped docs make false
claims about its own manifest), and **the standards that cost ongoing
discipline** (no contract tests, no cost accounting, no CI for the half where
the product now lives). One reviewer's sentence earns quoting because every
word of it verified: *"the repo quotes its own postmortem fluently while
re-running it."*

---

## Findings

Severity · finding · intention violated · evidence (all re-verified).

### CRITICAL

**C1 — Iteration does not exist.** The product's first noun — asserted in
`objectiveai.json:2`, `mcp/src/main.rs` description, `README.md:5` ("steer and
iterate"), `docs/why-rebuild.md` — has no tool, no UI affordance, no doc
deferring it. Legacy had five steering channels; its postmortem ordered the
feedback serializer taken "close to verbatim"; zero of five were taken. The
judge notes' Sadler form exists because feedback "has to be implementable"
(scoring.md §2) — and the product offers no one to implement it. `grep -rn
"iterate|feedback|promote|steer"` across both halves: only the word `iterator`
and the description text itself.

**C2 — The tier-2 contract tests were never built.** The plan's §7 called
contract tests against the live daemon "the one the old app lacked"; the only
thing named "contract" is `viewer/scripts/check-contracts.mjs`, a static lint of
`dist/` that opens no connection. Every SDK surface the product depends on —
the spawn stream, the delta protocol, the two divergent upstream specs — has
zero runnable verification. An SDK bump surfaces exactly as the plan swore it
wouldn't: a blank tab.

**C3 — Cost ceilings went from "correctness requirement with tests" to two
comments conceding defeat.** Generation *and* invention run unmetered on the
Claude subscription (`reports ZERO cost and ZERO tokens`); judges default to
real-money OpenRouter at 16k tokens with no per-run aggregate and no cap on
call count. The SDK exports `usage.cost` / `total_cost` on the spawn chunk
schema; nothing in either half reads them.

### HIGH

**H1 — The written record describes an abandoned architecture.** `README.md:44`
"This is a **viewer-only** plugin"; quick start runs `pnpm install` at a root
with no `package.json`, registers only the viewer half, omits the laboratory —
ending in the scaffold's signature *silent* failure (unregistered mcp half
builds from a GitHub tag that does not exist). `HANDOFF.md:71` — the mandated
first read — still says "Halves — **viewer only. STANDS**." `why-rebuild.md`'s
§6.3 bullet sits unstruck while the sibling decision was struck and dated. The
repo currently *documents* a deviation it no longer makes — the mirror image of
the brief's rule.

**H2 — Judgment ships half-invisible.** No spread, no dot-plot — a flat table
of `toFixed(2)` decimals with the score tonal scale (`--ph-color-score-*`,
"encodes magnitude") hardcoded to one colour. The computed facts — WCAG
contrast, palette drift, argued for at length in scoring.md §3 — travel to the
viewer (`ScoreEvent.facts`), are typed `unknown`, and are **never rendered**.
Judging is triggered by prose interpretation of the brief by gpt-4o-mini, is
disclosed only in a subordinate clause of the subtitle, and fails silent: a
dead judge is dropped (`orchestrator.ts:118`), the tools strip shows "N KB
back" for a failure, and a user whose judges all die gets a finished board with
no sign judging was attempted. Scores never touch the board; legacy's ranking
is gone. "Judgment as a surface, not a number" — the differentiator — survives
mostly in the decision documents.

**H3 — The TV owns the show and kills the broadcast.** Closing the tab cancels
the daemon-side agent (admitted in code, `phosphene.tsx` "KNOWN LIMIT"); no
reattach path exists (`agentsInstancesListener` appears only in that comment);
all run state is React state and dies with the webview; the display also
authors the agent's system prompt (duplicated with the plugin's
`with_instructions`, near clause-for-clause) and supervises its liveness with
its own watchdog. A 10–30 minute exploration evaporates on a tab switch.

**H4 — Boot gates on the functions surface.** `checkDaemon()` probes health via
`functionsListExecute` and the explore button is disabled unless it returns
ready — the one surface Ronald said to avoid, marked "being deprecated" in
HANDOFF's own table, with non-functions alternatives listed two lines below.
When functions are deleted, phosphene bricks itself on a healthy daemon. (The
probe also proves the wrong precondition: the *laboratory* is what explore
needs, and it is never checked.)

**H5 — Version identity is incoherent and immutability is protected by
nothing.** Three versions coexist: `v0.1.0` (registration/orchestrator),
`0.1.0` (viewer/package.json), `2.2.15` (mcp/Cargo.toml — the scaffold's
platform version, inherited unexamined, and self-reported by the MCP server via
`CARGO_PKG_VERSION`). No git tag exists; no release workflow exists; the repo's
own research (05-agent-identity) proved tag immutability is unenforced
platform-wide — and the in-repo protection is nothing.

**H6 — Frame fit: promised in the decision doc, never computed, architecturally
blocked.** scoring.md §3 and `main.rs` both assert viewer-side frame-fit in the
present tense. No viewer code computes it — and none *can* as built: both
iframes are `sandbox=""` (opaque origin), so the parent cannot reach
`contentDocument` to measure. The product's own data says overflow is its #1
failure mode. This needs a design decision, not just work.

**H7 — CI has never seen the product.** Both CI jobs are viewer-only; `cargo
test`/`build` and `mcp/Containerfile` — the release path for the entire tool
half, the one that demonstrably OOMs at default VM memory — are never
exercised. And with 18 commits unpushed, the remote is still the 2026-08-01
flat viewer-only layout: HANDOFF's "CI green" is true of a tree that no longer
exists.

### MEDIUM

**M1 — The salvage ladder is duplicated in two languages and untested in
both.** `parse_json_loose`/`strip_fences`/`strip_trailing_commas`/
`extract_html`/normalizers in Rust; `parseJsonLoose`/`stripTrailingCommas`/
normalizers in TS — ~230 lines of the most failure-prone logic, direct
descendant of the legacy postmortem, zero tests either side, while both copies
carry comments preaching "two copies only ever drift." The viewer has no test
runner at all; the 5 Rust tests cover only the facts math.

**M2 — "The agent picks" is honored only where it was convenient.** The jury:
yes, model mandatory. Invention and generation: upstream and model are
hardcoded consts, no tool argument can reroute them, and both core tools are
thereby coupled to a live Claude Code login on the daemon host — a hidden host
dependency inside a would-be immutable identity. The orchestrator's model is
likewise hardcoded in the viewer.

**M3 — Silent fallbacks, two of them lies.** A malformed palette silently
becomes a hardcoded fallback **byte-identical to the example palette in the
invention prompt** — the user sees colours no model chose, unflagged, and the
facts then measure "adherence" against them. Dead judges vanish without UI
trace. Judge notes default to `""` while scores fail loudly. Short palettes
render `#000000` swatches into the generation prompt.

**M4 — Wire shapes are hand-rolled past exported SDK types.** The SDK exports
the request type, the chunk union, and runtime Zod schemas; the viewer uses
`request as never`, `{} as never`, and inline casts at exactly the daemon
seams; the Rust half serializes the typed chunk back to JSON to walk it by
hand. §7's carve-out applies only where the SDK exports nothing.

**M5 — Scaffold-prescribed doc surfaces are fossils or missing.**
`mcp/README.md` is byte-identical to the template and asserts things false of
this repo (postgres opt-in, `*_deleteme` tools present, a `rename.sh` that was
deleted); `viewer/README.md` was dropped with no recorded reason;
`.agents/skills/script-agents/SKILL.md` teaches agents to call
`phosphene_scaffold_note_write_deleteme`, which does not exist; `mcp/Cargo.toml`
carries dead `reqwest`, a dead `sync` rationale, an uncommented `time`
addition, and metadata claiming to be the scaffold at ObjectiveAI's repo.

**M6 — The design judges never see the design.** Craft — "visual hierarchy,
spacing rhythm, typographic discipline" — is scored by a model reading HTML
source. The rasterization path the codebase keeps "on the table" is on the
table only. scoring.md never confronts that its craft dimension is optically
blind.

**M7 — The orchestrator under-executes and nothing checks.** *(Mine — observed
live, no reviewer covered it.)* The agent-ran test rendered 5 of 9 cells and
declared itself done; zero failures, mini simply stopped. No checklist in the
prompt, no completeness verification anywhere.

**M8 — Anchor-then-parallel lost its parallel.** The single orchestrator
renders all nine cells serially (~8–9 min); legacy fanned siblings after the
anchor. The coherence half survived (the cache pinning is genuinely good); the
latency half regressed.

### LOW

**L1 — Dead code in the display half:** `parseJsonLoose`/`stripTrailingCommas`
exported and imported by nothing; the viewer `runAgent`'s claude branch
unreachable (no caller passes `upstream`); `.ph-mini` CSS (5 rules) for a
component deleted in the Phase D rewrite.

**L2 — Docs without supersede banners:** `00-what-this-is.md` still issues a
live design directive built on vector completions; `05-agent-identity.md` says
"two tools (soon three)" while three ship.

### Credit, for calibration

All four reviewers, independently: the work genuinely lives behind tools
through the daemon with no key anywhere in the repo; cache-not-context is real
in both directions (anchor pinning, score lookup); disagreement is never
averaged and the judge model is mandatory; artboard colour-neutrality survived
byte-exact; the *conscious* deviations (postgres, build.mjs, frozen lockfile)
carry written reasons with unusual rigor; `resume.sh` and the contract lint are
exemplary silent-failure hunting for the packaging layer; stall-vs-timeout
error taxonomy is careful. The scaffold-tree fidelity — layout, lockfiles,
port discipline, deleteme hygiene, registration-trio guard — is near-perfect.

---

## Fix plan (for approval — nothing applied in this review)

**P0 · Truth.** One session, mechanical: rewrite README + HANDOFF for the
both-halves reality; strike and date why-rebuild §6.3; adapt `mcp/README.md`
and restore-or-formally-waive `viewer/README.md`; fix the skill example; set
`mcp/Cargo.toml` to 0.1.0 with honest metadata, drop `reqwest`, comment `time`;
de-fossil 00/05 with supersede banners. And **align the product's claims with
its contents** — which way depends on the P0 decision below.

**P0 · Decision (Maya): iteration.** Build it (a minimal
`refine_direction`-style tool taking judge notes + user feedback, plus the UI
verb — intersects the legacy-design reconciliation) or strike "iteration" and
"steer" from every claim until it exists. The one finding that changes what
phosphene *is*.

**P1 · Judgment made visible.** Render the facts; drive the score tonal scale
from data; per-dimension spread across judges; visible chip/row for a dead
judge; scores attached to the board; ranking. (Intersects the design task —
this is the differentiator's UI.)

**P1 · Platform seams.** Swap the functions probe for a non-functions
read (and check the laboratory too); reattach-by-AIH with the AIH persisted so
the board survives tab close (the actual TV); CI builds + tests the mcp half;
push so CI sees the product at all.

**P1 · Decision (Maya): frame fit.** A dedicated measuring iframe with
`allow-same-origin` (scripts still off) to make the promised fact real — or
amend scoring.md to withdraw it. As built it is impossible; the doc and the
sandbox cannot both stand.

**P2 · Discipline.** Tests for the salvage ladder (both languages) and the
tool-event accumulator; an on-demand contract-test runner against the live
daemon; read the SDK's usage fields and surface per-run spend, ceiling where
meterable; consolidate the duplicated procedure/prompt (the tools own the
workflow); orchestrator checklist + completeness check (M7); expose
upstream/model tool arguments or write down why not; delete the dead code.
