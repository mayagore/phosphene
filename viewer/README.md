# phosphene — the viewer half

The tab. It spawns ONE agent that declares this plugin and renders what
streams back — tool calls, artboards, verdicts. It does no design work
itself; the tools live in `../mcp/`.

Restored 2026-08-03: the scaffold prescribes a per-half README and this one
was dropped without a recorded reason during the layout refactor
(`docs/reviews/01-intention.md` F2).

## The load-bearing facts

- **React is external, always.** The host serves ONE React through the import
  map in its `tab.html`; a bundle carrying its own copy dies on the first
  hook. `build.mjs` lists the externals; `scripts/check-contracts.mjs`
  asserts them against every build, because nothing upstream can.
- **`viewer.development.output` is `viewer/dist`** (paths in the root
  manifest are repo-relative; the containerfile's own directory is its build
  context, so nothing inside `Containerfile` carries a `viewer/` prefix).
- **Styles ship via the manifest's `styles` array**, never `import "./x.css"`
  — a bundler strips the import and the host awaits the declared file.
- **Dev loop:** `pnpm run dev` watches into `dist/`; the viewer picks up a
  new build on tab switch. `pnpm run verify` = typecheck + build + the five
  contract assertions.
- **`build.mjs` deviates from the scaffold twice, with reasons inline**
  (no scripts pass; styles bundled rather than copied).

## Files

```
src/phosphene.tsx      the tab — display only, state derived from tool events
src/lib/agent.ts       one agent completion, stream folding, tool events
src/lib/orchestrator.ts  the one-button exploration agent + board derivation
src/lib/board.ts       cell vocabulary (no prompts here — those live in ../mcp)
src/lib/directions.ts  invention types + normalizer
src/transport.ts       the Tauri IPC transport the SDK rides
scripts/check-contracts.mjs  the five silent-failure assertions
```
