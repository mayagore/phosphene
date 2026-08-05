# Phosphene — Design

Design source-of-truth for the Phosphene app. Phosphene is *design iteration with judgment*:
a swarm of vision agents generates design directions and ranks them against your taste —
closing the gap between generating and evaluating.

**Figma:** https://www.figma.com/design/4NqOH4jScHXMGw8JZ0LbKP — owner `mgore@aum.edu`.

## Direction — the chat concept

The app is an **agent transcript**: *everything is a Turn*. It stays three-panel, but the left
rail is a **conversation**, not a control form.

- **Intent →** an opening Command Turn + the composer for follow-ups.
- **Ranked directions →** a **result Turn** in the transcript (the agent produced the ranking;
  the canvas rows stay rank-ordered).
- **Run config →** compact **chips** by the composer (directions · target · go-until-target).
- **Budget →** a persistent **status chip**.
- **Judgment is visible:** a swarm-vote distribution ("5 agents · 87% agreement") plus
  **per-criterion reasoning dropdowns** — every score carries a human-readable
  *"▴ WHY THIS SCORE"* explanation, not just a number.

Demo briefs are deliberately **fictional prompts** (e.g. *"a dating app where pickles match on
brine compatibility"*) so it's obvious the swarm designs whatever you type — and it adds personality.

## Lifecycle (wired prototype)

`First run → Generating → Reviewing → Iterating → Complete`
— the leading direction's score climbs **0.91 → 0.95** and the winner locks. See `screens/`.

## Foundations

- **Accent** blue `#4d9fff` for action / selection / judgment.
- **Artboards stay neutral** (white/gray/ink) — never tinted; blue is chrome only.
- Two modes: **Blue (dark, default)** + **Light**; artboard tokens are identical across both.
- **Tonal score scale** (`score-low → mid → high`) encodes magnitude at a glance.
- Type: ALL-CAPS eyebrows · sentence-case titles & buttons · no center-justified body copy.

All tokens (color · spacing · radius · type) live in **[`tokens.css`](./tokens.css)** as a
Tailwind v4 `@theme` block — ready to import into `phosphene-viewer`.

## Screens

| File | Screen |
|------|--------|
| [`screens/cover.png`](./screens/cover.png) | Cover / hero |
| [`screens/first-run.png`](./screens/first-run.png) | First run (chat) — empty / greeting |
| [`screens/reviewing.png`](./screens/reviewing.png) | Reviewing (chat) — swarm vote + reasoning dropdowns |
| [`screens/complete.png`](./screens/complete.png) | Complete — target reached, winner locked |
| [`screens/foundations.png`](./screens/foundations.png) | Foundations / token sheet |
