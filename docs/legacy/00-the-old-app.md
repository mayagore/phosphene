# The old phosphene — what it was, and what survives

> **Read at:** `mayagore/phosphene-legacy` @ `ee47aea` — 2026-07-12, 87 commits, ~10,400 lines.
> **Written:** 2026-08-01, by three agents reading the repo in full: product/UX,
> the ObjectiveAI integration, and engineering/history.
> **Why:** §6.4 — decide what, if anything, the rebuild consults. Default was
> nothing. This document is the evidence for changing that.

**The short answer.** The product ideas and the *knowledge* are worth a great
deal. The code is worth almost nothing — not because it was written badly, but
because roughly half of it exists to survive constraints that no longer exist,
and much of the rest is downstream of one bad decision (deleting the output
schemas). Take the prompts, the rubric, the design tokens, and the comments.
Leave the transport, the queue, the salvage parsers, and the mock path.

---

## 1. What it was

One screen, three panels, no routing. `App.tsx` is the whole app.

**Type a brief → 3 contrasting directions get invented and ranked → each renders
across 3 shared states as self-contained HTML → a swarm scores every board →
you steer → it iterates.** Optionally it loops autonomously until a target score,
round cap, or spend cap, then stops and tells you which limit it hit.

The grid is the idea: **rows are directions ordered by score, columns are states.**
Reading down is quality, reading across is coverage. The state labels are chosen
*by the model, per brief, and shared across all directions* — a fintech brief gets
landing/portfolio/transactions, a poster gets announce/lineup/tickets — so columns
compare like with like (`useDesignDirections.ts:53-66`).

Steering had five channels, all compiled into one English sentence and injected
into the next round's prompt (`useEditTracking.ts:222-259`): drag to re-rank,
prefer/reject, freeform note, **region annotation** (draw a box on a board,
describe that area, get percentage coordinates into the prompt), and **splice**
(select two boards, "combine these").

---

## 2. Three things it got right

**Judgment as a surface, not a number.** Every score carries a swarm vote
dot-plot and a written "why" (`Inspector.tsx:185-212`). You can see disagreement.
This is the actual differentiator and it survives any rebuild.

**Anchor-then-parallel generation.** State 1 renders alone; states 2–3 then fan
out with state 1's *literal HTML* inlined as input. The insight worth keeping is
in the comment: what drifts across independently-generated screens is **the shared
chrome — nav, spacing scale, component styling** — because colour and type are
already pinned by the palette/typography spec. Pinning actual markup, not a
description of it, is what holds a direction together
(`useDesignGeneration.ts:160-184`).

**Artboards stay colour-neutral in both themes.** `--color-artboard-*` is
byte-identical in light and dark, so the chrome never tints generated work
(`app.css:36-41`). The single best decision in the design system.

---

## 3. What it got wrong about the platform

This is the section that justifies the rebuild.

**It ran everything through Claude Code, not OpenRouter.** Every agent —
invention, generation, critique, and every swarm member — was
`{upstream: "claude_agent_sdk", model: "sonnet", output_mode: "instruction"}`
(`sdkHelpers.ts:255-267`). One model, one upstream, everywhere.

**The "swarm" had no diversity and no weights.** A swarm of N was N *byte-identical*
agents, `count: 1`, and the string `weight` appears nowhere in the codebase. So
the agreement metric measured **sampling variance of one model**, not judges
disagreeing. The code even carries a comment asserting *"The swarm is the
ObjectiveAI value — one agent is not a consensus"* (`types.ts:69-74`) while never
varying model, upstream, temperature, or prompt. **The core value proposition was
never actually exercised.**

**It deleted its output schemas, then paid for it forever.** Commit `3265016`
removed `DIRECTION_SCHEMA` and `GENERATION_SCHEMA` on the grounds that
`output_mode: "instruction"` carried the contract in prose. Everything downstream
— a four-layer JSON salvage ladder with a hand-written balanced-brace matcher, a
palette-object coercion, a `states?` shape absorber, duplicate-label suffixing —
exists because of that one decision (`sdkHelpers.ts:269-338`).

**It bypassed the SDK's types wholesale, and the flagship bug was the bill.**
Functions and profiles were built as `Record<string, unknown>` and cast through.
`split_index` **is typed by the SDK** — `split_index?: number | null` and
`task_index: number` on the task chunk. The code cast past it, the merged view
dropped the field, every task was skipped, every dimension fell back to its 0.5
default, and a whole board read **0.52 while the written critique beside it was
accurate** (`360576f`). The most insidious failure in the repo, and it was
self-inflicted.

**Three incompatible encodings of one request**, and `from_cache` is silently
dropped on the viewer path — so every `from_cache: true` was a no-op inside the
desktop app (`functionExecution.ts:29-41` vs `:95-97` vs `:167-178`). A live bug
nobody found.

**It never used the platform's enqueue/poll API**, which would have sidestepped
the single-in-flight problem entirely. Instead the whole app was built around a
serial queue with 30-minute timeouts, and the fix was escalated upstream as an
infrastructure ask.

---

## 4. The 32K ceiling — a correction to our own plan

The plan's §6.4 listed the anchor-then-parallel strategy as worth consulting
because it *"encodes a real 32K output-token ceiling."* **That framing is wrong,
and the correction matters.**

The ceiling is **Claude Code's / the Agent SDK's**, inherited only because the
agent declared `upstream: "claude_agent_sdk"`. It is not an ObjectiveAI
constraint, and it is not the model's — Sonnet-class models are 64K/128K max
output on the Messages API. The observed failure was *four `max_tokens` thinking
continuations over ~26 minutes*, then `32000 output token maximum` and an empty
stream (`useDesignGeneration.ts:9-16`) — i.e. **thinking tokens ate the output
budget**, which is why the mitigation was both a prompt line ("Keep planning
brief") and a structural split.

**So:** on a different upstream with a large `max_tokens`, the split may not be
needed *for size*. Keep anchor-then-parallel for **cross-state coherence**, which
is a real and transport-independent finding. Do not keep it as tribute to a
ceiling we may not be under.

---

## 5. What broke repeatedly

Nine recurring themes across 87 commits. Three dominate:

**Timeouts fighting each other (~7 commits).** Every layer grew its own ceiling
and they were never ordered: no timeout → 180s killing healthy 300s streams →
600s still wrong → the dev proxy's own 300s killing a stream the app allowed →
finally the right abstraction. **The fix that stuck: hang detection belongs on
the gap *between* chunks (120s), not on total duration, because a healthy
generation legitimately runs 10–25 minutes.** Everything else is a labelled
backstop, and every outer layer must strictly outlast every inner one.

**Errors swallowed, then over-corrected (5 commits).** Silently dropping error
chunks surfaced as a misleading "Empty function execution response"; the
over-correction threw on *every* error including `fatal: false` advisories, so a
benign "auto-update failed" aborted a good review. The resolution is the
fatal-vs-advisory split — which Pass 1 found the platform documents exhaustively
in `ERRORS.md`. **The old app hand-rolled a taxonomy that already existed.**

**Rasterization, four attempts across the project's whole life** — ending in
html2canvas inside a `sandbox="allow-same-origin"` (scripts off) iframe, JPEG at
1.5× q0.82 because 9 boards of PNG@2 hit a **413 Payload Too Large** and the
review never ran (73 KB vs 398 KB measured per board).

Also recurring: scores that looked real but weren't (six sub-scores that were
arithmetic of other scores, presented as measurements); cost accounting drifting
to zero through four successive fallbacks; state leaking across rounds; and
squash-merges silently dropping a shipped fix, caught only by another soak.

---

## 6. The rasterization conflict — flagging this against Spike D

`screenshot.ts:72-81` states, from a live 2026-07-10 reproduction in **plain
Chromium**:

> "drawing a foreignObject-SVG taints the canvas in EVERY modern browser — not
> just WebKit as the old comment claimed — so toDataURL throws SecurityError and
> the whole optical review runs blind. **That is a browser security guarantee,
> not a bug we can normalize around.**"

**Our Spike D found the opposite**: SVG `foreignObject` → `Image` → `drawImage` →
`toDataURL` produced a 2 KB PNG with no taint, in the actual plugin-tab webview
(`docs/spikes/01-calibration.md` §D).

Both are empirical. The differences: our probe was a **120×40 trivial document
with inline styles and no external resources**, run in **WebKit inside Tauri** in
August; theirs was a **full generated design document** in Chromium in July.

**Resolution: treat Spike D as promising but not yet load-bearing.** Before any
design depends on in-page rasterization, re-run it with a realistic payload — a
full 400×720 generated artboard with a system font stack — in the real plugin
tab. If it still doesn't taint, the old app's dead end was narrower than it
believed, and html2canvas is unnecessary. If it does taint, the old finding
stands and html2canvas (or a server-side renderer) comes back.

Two adjacent findings from the old app that hold regardless:
- **`image/svg+xml` is not a valid vision input.** Claude's vision API takes
  JPEG/PNG/GIF/WebP and rejects SVG, so an SVG fallback must never be sent as an
  `image_url` — it would turn silent degradation into hard failure.
- **Payload budget is real.** Review rasters ride as base64 in a *single* request
  body, up to 9 boards at once.

---

## 7. What to reuse — the §6.4 verdict

**Take these, close to verbatim:**

1. **The six scoring dimensions with their prompt fragments**
   (`useDesignReview.ts:30-40`) — contrast, whitespace, visualHierarchy /
   semanticStructure, accessibility, codeQuality. Compact, non-overlapping, half
   optical and half code-grounded.
2. **The 5-level Likert ladder and its non-linear mapping** —
   `["poor","adequate","good","strong","exceptional"]` →
   `[0.2, 0.45, 0.65, 0.8, 0.93]`. The compressed top end is a deliberate
   calibration choice so "exceptional" isn't 1.0.
3. **Likert-over-numbers.** Ask the model to choose among rendered natural-language
   statements rather than emit a float. This is what makes vote distributions
   meaningful, and it is exactly what the platform's vector completions want.
4. **`GENERATION_REQUIREMENTS` verbatim** (`useDesignGeneration.ts:144-158`),
   including the "realistic placeholder content — real-looking names, dollar
   amounts, dates — not Lorem ipsum or John Doe" line.
5. **The invention prompt** (`useDesignDirections.ts:170-183`) — especially
   "3 genuinely different, not variations on one theme", the semantic 5-slot
   palette contract, and the shared-states ask that makes a comparison grid
   possible at all.
6. **`buildDirectionPrompt`'s feedback serializer** (`useDesignGeneration.ts:205-297`)
   — reviews, weak-area thresholding at `< 0.75`, promote/demote, region
   annotations as percentage rects, splice requests. Complete and transport-independent.
7. **Critique separate from scoring.** The swarm produces a distribution; one
   agent produces prose; the prose never re-scores.
8. **Agreement from real vote spread** (`1 − 2·√variance`), and the principle
   behind it: *every number displayed must be genuine signal, not arithmetic on
   other displayed numbers* (`types.ts:22-25`).
9. **The design tokens** (`design/tokens.css` / `app.css:4-98`) — a real Figma
   variable collection, coherent, with artboard-neutrality as its best rule.
   Note the one crack: red is un-tokenized (`ErrorBanner.tsx` reaches for raw
   Tailwind `red-500`), and all iconography is bare Unicode glyphs.
10. **The chunk-gap watchdog pattern**, and the `__test` named-export convention
    for testing module internals without polluting the public API.

**Take the knowledge, not the code:** the dated comments are the highest-value
artifact in the repo after the tokens. Most of them are facts about *models and
platforms*, not about this codebase, so they remain true. The twelve best are
catalogued in the agent reports; the ones that shaped this document are quoted
above.

**Leave behind:**

- The entire transport layer — `enqueue()`, the dual viewer/standalone paths,
  `ViewerPluginExecutor`, `toSpawnRequest`/`foldSpawnStream`, `classifyStreamError`,
  `cliErrorMessage`, the api.lock-sniffing Vite proxy.
- The JSON salvage ladder. Use typed requests and real output schemas instead.
- `viteSingleFile()`, `base: "./"`, and 97 KB of base64 Inter — the shipped
  `dist/index.html` was **10,615,418 bytes**, one inline script of 10.49 MB,
  almost all of it the SDK.
- `html2canvas` and `screenshot.ts` — pending the §6 re-test.
- `sessionStore`'s 4.5 MB quota-shedding loop, and the three-tier cost estimator
  that ends at `chars / 4`.
- The mock path — a parallel implementation living *inside* the production hooks.
  Prefer a mock transport.
- Dead code: `useProgress` (inert, re-renders the app every second for a value
  nothing reads), `variantScores`, `AGENT_TEXT`, the `code` turn kind, colour
  overrides (fully plumbed, no UI).

---

## 8. Two things the rebuild should fix that the old app never did

**The composer is a lie.** Its placeholder reads *"Describe a change — e.g.
'bolder CTA, tighter hero'"*, but submitting it **archives the board and starts a
brand-new brief** (`App.tsx:509-545`). No code path feeds composer text into
iteration. The transcript rail renders beautifully and you cannot talk to it.
There is also a `/` badge and a "/ commands" hint with no slash-command handling
anywhere.

**The shipped rubric is weaker than the designed one.** `design/screens/reviewing.png`
specifies **visual hierarchy · trust & credibility · conversion clarity · brand
fit · accessibility** — product-level design judgment. The code ships generic
web-dev lint. Reuse item #1 above is the *shipped* rubric because it is proven and
non-overlapping; the *designed* rubric is the more interesting target and should
be weighed in §6.1.

Related: scoring was only ever **per-direction**, so all three cells in a row
showed an identical number, while the mockup shows scores varying across a row.
And direction metadata — palette, typography, mood — is invented, fed to
generation, and **never rendered anywhere**.

---

## 9. Corrections to prior research

1. **The 32K ceiling is not a platform constraint** (§4). The plan's §6.4 framing
   was wrong; keep anchor-then-parallel for coherence, not for size.
2. **Pass 1 finding #3 is confirmed and sharper.** The old app did build functions
   and profiles inline in TypeScript per request — as untyped `Record<string,
   unknown>` — and the `split_index` collapse was the direct cost of casting past
   types the SDK already provided.
3. **Pass 1's error-taxonomy finding is confirmed from the other side.** The old
   app hand-rolled *three separate* error classifiers over five commits, arriving
   at a fatal-vs-advisory split that `ERRORS.md` documents exhaustively upstream.
4. **Spike D is now contested** (§6) and needs a realistic-payload re-test before
   anything depends on it.
5. **The old app never exercised swarm diversity** — which means it never actually
   tested the platform's central claim, and neither have we.
