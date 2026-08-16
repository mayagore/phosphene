# Recency and trajectory

> **Read at:** `ObjectiveAI/objectiveai` @ `649b1d7cf` (`v2.2.15`) — 2026-07-31 22:07:33 -0500
> **Pass:** 4 of 4 — recency and trajectory
> **Written:** 2026-08-01

**Sources:** `git log` across `v2.2.9…v2.2.15` filtered to the plugin/viewer/
scaffold/SDK trees; the GitHub release list; `npm view @objectiveai/sdk`
versions and publish times; all 60 open issues, filtered to the plugin surface.

**Note on this pass's own history:** `v2.2.15` is **ours** — the three boot-check
defects plus a cherry-picked laboratory fix, shipped 2026-08-01 as
[PR [#302](https://github.com/ObjectiveAI/objectiveai/issues/302)](https://github.com/ObjectiveAI/objectiveai/pull/302). This artifact
therefore describes a changelog phosphene is now part of.

---

## 1. The shape of the last month

| Release | Date | Commits touching plugin/viewer/scaffold/SDK | Total |
|---|---|---|---|
| v2.2.10 | 2026-07-08 | 204 | 268 |
| v2.2.11 | 2026-07-16 | 112 | 206 |
| v2.2.12 | 2026-07-17 | 15 | 30 |
| v2.2.13 | 2026-07-28 | **205** | 258 |
| v2.2.14 | 2026-07-30 | 28 | 42 |
| v2.2.15 | 2026-08-01 | 5 | 7 |

Gaps between releases: 8, 1, 11, 2, 1 days. **This is not a project on a release
train** — it ships when something is ready, sometimes twice in 48 hours.

Roughly **three quarters of all commits touch the surface phosphene depends on.**
That is the single most important number in this document: there is no stable
core to hide behind. The platform *is* the surface.

---

## 2. Where the breaking changes actually land

**37 commits since v2.2.9 carry the `!` breaking marker.** Concentrated by area:

**v2.2.13 (2026-07-28) — the plugin rewrite.** Twelve breaking commits in the
plugin paths alone, including `feat(plugin-framework)!: a plugin declares its own
identity`, four more `plugin-framework!` refactors, and two that phosphene
inherits directly:

- `refactor(viewer)!: the chrome is two band webviews, not one document` — the
  40px/32px band geometry Pass 2 §1 documents.
- `refactor(viewer)!: a tab kind is common fields plus a surface` — the
  `Surface::Component | Surface::Browser` split that Pass 2 §2 and §8 rest on.

**v2.2.14 (2026-07-30) — the scaffolder, and the manifest's last break.**

- `feat(plugins)!: the manifest opts in to postgres — mcp.postgres` (now required)
- `refactor(sdk)!: rename plugins manifest Development to McpDevelopment`
- `refactor(viewer)!: development mode rides argv — respawn is propagation` — the
  frozen-registry model in Pass 2 §6
- `feat(viewer)!: bridge carries the full child-side mailbox, closure-locked` —
  the `__objectiveai.send/subscribe/list` surface in Pass 2 §8

**The viewer plugin scaffold is 4 days old.** Born `a34226214`, 2026-07-28
20:33. Phosphene is its first real consumer, and the three defects we found and
fixed in v2.2.15 are what "first consumer" means in practice.

**Read this as a rate, not a backlog.** The manifest schema broke in v2.2.13
*and* v2.2.14, back to back. Nothing indicates it has settled — only that nobody
has needed to break it since 2026-07-30.

---

## 3. The npm gap — confirmed, and it matters for the pin

`@objectiveai/sdk` published versions: 23 total, most recently
**2.2.8, 2.2.9, 2.2.10, 2.2.13, 2.2.14, 2.2.15**.

**2.2.11 and 2.2.12 were never published** (nor 2.2.4). The plan's §4 attributed
this to `fix(release): pin npm and node together so the js publish stops
breaking` — consistent with the record.

The consequence for phosphene is concrete: **a git tag existing does not mean the
SDK is installable.** The scaffold pins `"@objectiveai/sdk": "2.2.14"` exactly
(now 2.2.15), and an exact pin against a version that never reached npm is an
unresolvable install. Before moving the pin, check npm, not the tag list.

---

## 4. Where the next break is likely

Ranked by probability of hitting phosphene, from the open-issue set:

**1. [#281](https://github.com/ObjectiveAI/objectiveai/issues/281) — plugin whitelist, "require user sign-off before any plugin installs
or runs (post-2.2.13)."** Labeled `enhancement`, open since 2026-07-21. This is
the one to watch: it changes the *install and run* path, which is the path
phosphene ships on. It also directly answers a gap Pass 3 §5 flagged — that
`daemon_execute` proxies with no allowlist, so a plugin tab reaches the entire
CLI surface under the viewer's identity. A whitelist is the obvious response to
exactly that.

**2. [#293](https://github.com/ObjectiveAI/objectiveai/issues/293) — "state-preserving hot reload for plugin tabs (React Fast Refresh,
not remount)."** Filed 2026-07-30, the day the scaffolder shipped. If it lands,
it **obsoletes the rung-2 build constraint** that Pass 2 §6 and the boot check
established — the constraint that a `.tsx` save must touch exactly one consumed
file. Phosphene should not over-engineer its build around a rule that may
disappear; the conditional-CSS-copy fix is cheap and worth doing anyway, but
nothing more elaborate.

**3. [#301](https://github.com/ObjectiveAI/objectiveai/issues/301) — "make objectiveai P2P; consolidate objectiveai-api and
objectiveai-laboratory into new objectiveai-provider."** Filed 2026-07-31, the
newest issue in the repo. The laboratory is what builds plugin viewer images and
runs the release path. A consolidation at that layer would rewrite the release
ritual Pass 3 §4 documents. Large, speculative, no timeline — but it is the only
open issue that could invalidate a whole pass.

**4. [#287](https://github.com/ObjectiveAI/objectiveai/issues/287)/#288/#289 and [#278](https://github.com/ObjectiveAI/objectiveai/issues/278)/#279/#280 — MCP plugin scaffolds and frameworks for
JS, Go, Python.** Six issues, all open since 2026-07-21/28. Today the only MCP
half is Rust. **If phosphene wants an MCP half (§6.3) and would rather not write
Rust, [#287](https://github.com/ObjectiveAI/objectiveai/issues/287) is the issue to track** — a JS scaffold would remove the single
biggest cost of shipping both halves.

**Not a risk:** [#172](https://github.com/ObjectiveAI/objectiveai/issues/172) (viewer in the browser), [#171](https://github.com/ObjectiveAI/objectiveai/issues/171) (viewer as GUI swarm
orchestrator), [#253](https://github.com/ObjectiveAI/objectiveai/issues/253) (mobile laboratories), [#259](https://github.com/ObjectiveAI/objectiveai/issues/259) (laboratory git viewer). All
additive, none touching the plugin contract.

---

## 5. The upgrade ritual, and what it costs

The scaffold pins the SDK **exactly** (`"2.2.15"`, not `^2.2.15`), and the
viewer pins the whole toolchain. So an upgrade is deliberate, never automatic.
What it costs, from this pass:

- **Check npm first** (§3) — the tag may not be installable.
- **Read the `!` commits in the changed window**, filtered to the plugin paths.
  At the observed rate that is 5–12 commits per release, not 250.
- **Re-run the boot check.** It is now a known-good procedure with a recorded
  pass on v2.2.15 (`docs/spikes/00-boot-check.md`), and it caught three defects
  the first time it ran.
- **Re-read the pass covering any changed surface**, per the plan's §7. Pass 2
  for `objectiveai-viewer/`, Pass 3 for the scaffold and manifest.

**The contract tests the plan's §7 asks for are worth more here than in a normal
project.** Three quarters of commits touch our surface, and the manifest has
broken twice in the last month. A red test is how a breaking change should
announce itself.

---

## 6. Corrections to prior research

1. **The plan's §9 risk "another breaking change is likely" was understated as a
   *risk*.** It is the observed baseline: 37 breaking commits in six releases,
   two of them reshaping the manifest in the same week. Treat breakage as the
   normal condition, not a contingency.

2. **"Nobody has ever used the scaffolding" is now measured, not inferred.** The
   viewer scaffold was four days old when we first built it, and it did not
   build — `pnpm run build` failed on the untouched template, and no plugin tab
   could render in any release viewer. Both are fixed in v2.2.15.

3. **The HANDOFF's "no host-shim fix in flight" is resolved.** There was none.
   We wrote it.

---

## 7. What this changes for phosphene

1. **Pin exactly, upgrade deliberately, and never on the strength of a git tag.**
2. **Do not build elaborate machinery around the hot-reload rung rule** — [#293](https://github.com/ObjectiveAI/objectiveai/issues/293)
   may remove it. Make the CSS copy conditional and stop there.
3. **Track [#287](https://github.com/ObjectiveAI/objectiveai/issues/287) before committing to §6.3.** A JS MCP scaffold materially
   changes the cost of shipping both halves.
4. **The boot check is now a maintained asset**, not a one-off. It runs on every
   SDK bump.
5. **Being upstream's first real consumer is an ongoing role, not a phase.** We
   found three defects on day one of actually running the thing. At a 75%
   surface-touch rate, there will be more — and reporting them is cheaper than
   routing around them, which is what `why-rebuild.md` said from the start.

---

## 8. Open questions

- Does [#281](https://github.com/ObjectiveAI/objectiveai/issues/281)'s whitelist land before phosphene's first release? It changes the
  install path we would ship on.
- Is there any commitment behind [#301](https://github.com/ObjectiveAI/objectiveai/issues/301), or is it a thinking-out-loud issue? It is
  the only open item that could invalidate Pass 3.
- Does the `2-2-15` branch (still carrying `ffcb1f2`, the podman-download
  timeout fix, unmerged) get folded into a `2.2.16`, or was it superseded by our
  `2-2-15-2`? Worth asking upstream rather than guessing — we branched around it.
