# Scoring — what phosphene judges, and how

**Decided 2026-08-03.** Dimensions are Maya's. Everything else is argued from
`docs/legacy/00-the-old-app.md`, the design-evaluation research memory, and a web
pass over what comparable tools and the literature actually do.

**The two constraints that shape the mechanism**, both from Ronald: **no
distributed votes** (vector completions and logprobs are not the platform's pitch
any more, and a plugin can never reach one) and **no functions**. So scoring is N
ordinary agent completions and nothing else.

---

## 1. What we score

Four dimensions. Scored **separately, never combined**.

| | The question it asks |
|---|---|
| **craft** | Is it well made? Hierarchy, spacing, type, colour discipline, detail. |
| **distinctiveness** | Is this genuinely its own direction, or a generic template with the palette swapped? |
| **fitness to brief** | Does it serve *this* brief, or would it suit any brief? |
| **coherence across states** | Do the three states read as one product? |

Each 0–1, on the calibration the legacy app's research settled on and which costs
nothing to reuse:

```
0.5 generic · 0.7 good · 0.85 portfolio-worthy · 0.95 exceptional
```

### No overall score

Legacy had `overallScore`. Do not reproduce it. Analytic rubrics — independent
criteria scored separately — exist specifically "to prevent criterion conflation
and **halo effects**", and Design2Code deliberately refuses to aggregate its
metrics for the same reason. Four numbers and the spread between judges is the
output. A single number is a worse version of it.

### Not scored: usability, interaction, learnability

UICrit scores these; we cannot. Multimodal judges "approximate expert ratings on
visual dimensions but remain unreliable for interaction-dependent usability
judgments from static screenshots" — and our judges read static HTML. Scoring it
anyway would manufacture a number with nothing behind it.

### Why these four and not the field's

Every comparable tool measures **fidelity to a reference** (Design2Code, Figma
Make, v0) or **generic quality** (UICrit, Stitch). None asks *"is this a distinct
direction that serves this brief"*, because none of them are exploring
alternatives. Distinctiveness and fitness-to-brief are phosphene's own, and
coherence-across-states closes the loop on anchor-then-parallel — the strategy
exists to produce it, and the legacy app never measured whether it worked.

Legacy's own six — contrast, whitespace, visual hierarchy, semantic structure,
accessibility, code quality — are all facets of **craft**. They become evidence a
judge cites, not six numbers competing for attention.

---

## 2. Every score carries a written why

A number alone is not judgment. The legacy app got this right and it survives:
*"every score carries a vote dot-plot and a written why — you can see
disagreement."*

Each note follows **Sadler's three-part form**, which both our own research and
UICrit's annotation protocol independently landed on:

> the expected standard · the gap between the design and that standard · how to
> close the gap

Written as improvement instructions, not opinions. And each note **names the
element it is about** — a selector, a component, a region. UICrit attaches a
bounding box for this; we cannot rasterize cheaply, so naming the element is the
same idea at a price we can pay. UXBench's finding is the reason: identifying a
problem is not enough, it has to be implementable.

---

## 3. Computed facts, never judged

Asking a model to eyeball arithmetic is strictly worse than doing the arithmetic.
These print **beside** the scores as facts, and are not part of any score:

| Fact | How |
|---|---|
| **WCAG contrast ratios** | bg/text, surface/text, accent/on-accent, from the declared palette |
| **Frame fit** | content height vs 720, plus any internally clipped region. Needs layout, so it is computed **viewer-side** where the artboards already render in iframes — the plugin container has no browser. The other facts are computed in the tool. |
| **Palette adherence** | are the five declared hexes the ones the document actually uses, or did it drift? |
| **Font adherence** | does the CSS use the declared stack? |
| **Contract compliance** | no external resources, no JavaScript, valid XHTML |

Palette drift is worth measuring because it is the failure Stitch is publicly
known for — *"colors drift from brand systems"* — and it is invisible to a judge
reading prose.

---

## 4. How it runs

### The agent picks the jury; phosphene owns the rubric

**One tool call = one judge, one direction.**

```
phosphene_score_direction(brief, direction_index, model, upstream?) -> Score
```

The orchestrating agent calls it N times with N models. **Which models, and how
many, is the agent's and the user's choice, not phosphene's.** Hard-coding a panel
would bake in a stale model list and take a decision that is not ours — the
viewer is a TV for watching your agent work, and the jury is part of what you are
watching it decide.

`model` is required and has no default, so a panel is always explicit.

### Disagreement is the product

With vote distributions gone, **the spread between judges is the entire signal**.
Our own 4-model run had 7 of 8 votes one-hot — the signal was model diversity all
along, so nothing is lost by discarding distributions.

- Show every judge's number per dimension, and the spread.
- Never average into one figure, never hide the range.
- Two judges disagreeing sharply on distinctiveness is *information*, not noise
  to be smoothed.
- If every judge agrees on everything, the panel is not doing its job — that is a
  signal to check the models are actually different, not a sign of confidence.

### Per-judge isolation

A flat batch is all-or-nothing; one dead judge must not kill the panel. Each call
carries its own error handling, exactly as `generateBoard` does per cell.

### Artboards do not travel through the agent's context

The sharp mechanical problem. Three states × ~9 KB of HTML cannot be passed as
tool arguments — the orchestrating agent would have to echo ~27 KB verbatim, which
is expensive and which models get wrong.

**So `render_state` caches what it produced, in the plugin, keyed by
(agent instance, direction index, label), and `score_direction` looks it up by
index.** The container is per-agent and ephemeral, which matches the lifetime
exactly. An in-process map, not a database.

If containers turn out to be recycled between calls, the fallback is postgres —
which means reversing our `mcp.postgres: false` deviation, with this as the
written reason.

---

## 5. Shape of a result

```jsonc
{
  "direction": "Neon Pulse",
  "judge": "…model the agent chose…",
  "scores":  { "craft": 0.72, "distinctiveness": 0.85,
               "fitness": 0.60, "coherence": 0.90 },
  "notes":   { "craft": "standard … gap … fix", "…": "…" },
  "facts":   { "contrast": { "bg_text": 8.1, "accent_on": 3.2 },
               "fit": { "overflow": 0, "clipped": 0 },
               "palette_adherence": 0.94 }
}
```

The tab collects these across judges and renders, per dimension, the points and
the spread — plus every written why. That is "judgment as a surface, not a
number", which is the one thing the legacy app got right and the whole reason
phosphene exists.

---

## Sources

Legacy rubric: `phosphene-legacy/src/types.ts` (OpticalReviewResult,
TechnicalReviewResult). Calibration and Sadler: the design-evaluation research
memory. Plus [UICrit](https://arxiv.org/html/2407.08850v2),
[UXBench](https://arxiv.org/pdf/2606.16262),
[Design2Code](https://salt-nlp.github.io/Design2Code/),
[rubrics across the LLM landscape](https://arxiv.org/html/2606.08625v2),
[expert ratings in mobile UI usability](https://link.springer.com/chapter/10.1007/978-3-032-30549-7_12),
[Google Stitch review](https://www.index.dev/blog/google-stitch-ai-review-for-ui-designers).
