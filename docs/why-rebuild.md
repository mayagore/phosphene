# Why we are rebuilding phosphene

> Captured from Maya, 2026-07-31. This is the brief. Every later decision
> answers to it.

## In Maya's words

> Rebuilding to fit the new scaffolding and recreate the plugin to run better per
> scaffolding, because nobody's ever actually used it.

## What that means, unpacked

**The goal is fidelity to the scaffolding.** Not a product reinvention. Phosphene
stays phosphene — design iteration and judgment. What changes is that it is built
the way the platform now says plugins are built, instead of the way one was
improvised before that way existed.

**Being the first real user is part of the point.** No third-party plugin exists
on the current schema; the five first-party ones are all still on the dead
`filesystem.plugins` shape. The scaffolding shipped 2026-07-30 and has never been
driven by a real application. Phosphene is that first drive. Two consequences:

1. **Expect to find scaffolding bugs and gaps**, and expect them to be ours to
   report rather than route around. "Nobody's ever used it" means the paths we
   take may be genuinely untrodden.
2. **Deviating from the scaffolding needs a reason written down.** The default is
   to do it the scaffold's way even where the old app's way worked, because
   proving the scaffold out *is* the deliverable.

**"Run better per scaffolding"** — the old app spent most of its engineering
fighting an environment that no longer exists: an opaque-origin iframe, a
single-in-flight bridge, a 10.6 MB single-file bundle, base64-inlined fonts, a
hand-rolled Vite proxy. None of that is necessary now. Running better means
letting the platform do what it already does.

## What this settles

- **§6.1 "what phosphene is on this platform"** is narrower than the plan framed
  it. It is phosphene, done properly on the scaffolding — not a reimagining.
- **Deviation is the thing that needs justifying**, not conformity.

## What this does not settle

- Whether the review's **function and profile should be git-hosted and trained**
  (Pass 1 finding #2) rather than assembled in code per request. This is still
  open — but the brief tilts it: git-hosted, content-addressed, commit-pinned
  functions with learned profiles *are* the platform's intended way. If the
  scaffolding way implies it, the brief says do it that way.
- ~~Repo location and name (§6.2).~~ **Decided 2026-07-31:** GitHub
  `mayagore/phosphene` (the repo name is the plugin name on release), local
  `~/Programming/phosphene`, old repo renamed to `mayagore/phosphene-legacy`
  rather than deleted.
- Viewer-only vs. both halves (§6.3). The brief pushes toward whatever the
  scaffolding treats as the main path — and `scaffold.sh` only emits both halves,
  while the README frames plugins as MCP-server-first with the viewer as an
  optional adjunct. Worth weighing against phosphene genuinely not needing a
  server today.
- Toolchain (§6.5) — though again, deviation from the scaffold's esbuild
  `build.mjs` now needs a written reason.
