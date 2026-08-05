# Design — the blue chat concept, adopted without fabricated numbers

**Decided 2026-08-05** (plan approved by Maya; landed same day). The viewer
takes the legacy redesign's shape — `design-legacy/` (README, tokens,
screens) is the frozen source, from `mayagore/phosphene-legacy` PR #14 and
the Figma file `4NqOH4jScHXMGw8JZ0LbKP` (loop strip `151:95`, Components
page `1:41`). Every departure from that design has a reason below; the
standing law it must all obey is `docs/scoring.md` §1: dimensions are
scored **separately, never combined**.

## Adopted

- **Three panels.** Rail = agent transcript ("everything is a Turn"),
  center = the board, right = Inspector. Turns are a pure fold over run
  state (`lib/turns.ts`), the same derivation discipline as the board.
- **One composer.** Its action follows the phase — explore → refine →
  retry — with stop and resume beside it. An Inspector "iterate" scopes the
  next feedback to the selection: the loop's fourth stage (*your edits
  become the next round's intent*) as typed feedback.
- **The token system** (already in `tokens.css`): blue chrome, neutral
  artboards (identical both modes — chrome never tints generated work),
  Inter (base64 `@font-face` — `plugin://` serves no CORS), tonal score
  scale driven by data (`scoreTone`: ≥0.85 high, ≥0.7 mid), ALL-CAPS
  eyebrows, dark default + light via `data-theme` on the tab root.
- **Per-cell states** (Artboard Card: Queued / Generating / failed /
  Scored / Selected), score chips on boards, selection ring, rank-ordered
  columns, WHY-THIS-SCORE disclosures, History, Prefer.
- **The pan/zoom canvas** (Phase C, landed on Maya's go): the board is a
  stage — drag pans, wheel zooms anchored at the cursor, double-click a
  board opens it, double-click the background (or the pill %, or the fit
  chip) frames everything. Cells sit at TRUE 400×720; one transform does
  all scaling, headers are sized in canvas units, and rank reorders only
  animate x/y — no DOM move, no iframe re-parse. Ported from the legacy
  Canvas with the move/region/annotation subsystems dropped.
- **PNG export** via the Spike D path: the zoom modal rasterizes any board
  (SVG `foreignObject` → Image → canvas, 2×) and saves or copies it. One
  measured trap recorded in `lib/rasterize.ts`: the SVG must ride a
  `data:` URL — Chromium-family engines taint the canvas after drawing a
  `blob:`-loaded foreignObject SVG, and the same markup through a data URL
  exports clean. (`save png` uses `<a download>`, which some webviews
  ignore — `copy png` is the fallback; both fail loudly.)

## Adapted — the idea kept, the numbers made honest

- **Overall score → per-dimension medians.** No cross-dimension aggregate
  exists anywhere. Ranking is per-dimension (median across judges within
  ONE dimension); the ranked turn and column order follow a selected
  dimension (chips in the center header, default fitness-to-brief); the
  verdict names each dimension's leader.
- **Swarm-vote dots → judge points.** Vote distributions don't exist (by
  design — and the platform itself moved off logprobs, `04-where-its-going`
  §4). The Inspector draws one dot per judge per dimension on a track, a
  spread band, a median needle, and every judge's written why.
- **$ budget chip → run-budget chip.** claude_agent_sdk reports zero cost,
  so no dollar appears. The chip shows the run's REAL budgets: tool calls
  against the driver's hard cap, KB streamed, judges reporting, elapsed
  (computed at render on stream ticks — never a timer).
- **Prefer** is a local marker (`phosphene.preferred.<explorationId>`)
  that genuinely steers the next round: the refine feedback carries it and
  the agent anchors on the preferred direction's stored boards.
- **History** is a local list (`phosphene.history`, capped, shed-oldest)
  of resume keys — the database stays the truth; `resume:<id>` works on
  any entry. (An MCP `list_explorations` tool would make it global —
  recorded follow-up, not needed for the menu.)
- **Code turn → source view.** The concept's code snippet was a mock; the
  real code is the boards themselves. The zoom modal shows any board's
  XHTML and copies it; a selected cell offers copy from the Inspector.
- **Facts rendered** (`TECHNICAL · MEASURED`): the contrast ratios (flagged
  below 4.5:1 AA), palette adherence, fonts/js/external checks, and
  `statesSeen` that always rode on every verdict and were never shown.
- **Dead judges are visible**: a failed `score_direction` becomes a JUDGES
  turn and an Inspector row, never a silent skip — including error shapes
  without the stream's "tool call failed" prefix (raw MCP errors).

## Dropped, with reasons

- **Agreement % / vote weights** — the distribution they summarized no
  longer exists; judge spread IS the signal.
- **Target score / go-until-target / "push for 0.95?"** — bounded runs
  replaced open loops after the stuck-run incident (spikes/02 §9).
- **"Rank by taste vector"** — no separate taste stage; rank derives from
  judges.
- **Cost estimates** — no data (recorded P2 leftover, blocked upstream).
- **Per-cell KB counter** — documents arrive whole per tool result.
- **Undo/redo** — postgres keeps one row per cell (`round` increments,
  old HTML is overwritten). Follow-up recorded: keep per-round rows to
  unlock undo and round diffs.
- **Prefer-as-lock ("Locked")** — nothing consumes a lock; Prefer covers
  the intent honestly.

## Known limits, stated

- The host webview background is a Rust constant (`#0c0a09`): light mode
  flashes dark for a frame at boot and cannot change it.
- ~~The light-mode "Complete" chip sits low-contrast~~ fixed: the chip is
  chrome, so light mode restyles it with `accent-press` (the score scale
  itself stays mode-invariant).
- A plugin whitelist is coming upstream (#281, default-deny): first-run
  copy treats an unreachable daemon as a calm gate, never an error.
- `save png` in the tab webview is best-effort (`<a download>` may be
  inert there — verified in Chrome, not in the webview); `copy png` and
  `copy html` cover hand-off either way.
