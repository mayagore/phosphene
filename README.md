# phosphene

Design iteration and judgment, as an ObjectiveAI **viewer plugin**. Describe a
brief; get contrasting design directions rendered across shared states; let a
swarm score them; steer and iterate.

## Quick start

```bash
pnpm install
pnpm run dev                    # watch build -> dist/
objectiveai development plugins viewer create \
  --owner mayagore --name phosphene --version v0.1.0 --path "$PWD"
objectiveai viewer spawn
```

The tab reports its own health to the viewer's log inbox on boot
(`phosphene: ready · daemon round trip Nms`). If the tab is blank, look there
first — `~/.objectiveai/state/default/viewer/viewer-logs/`.

To go back to the installed copy:

```bash
objectiveai development plugins viewer delete \
  --owner mayagore --name phosphene --version v0.1.0
```

## Identity

**Not in this repo.** Owner, name, and version come from the git tag on release
and from the `development plugins viewer create` registration in development.
`objectiveai.json` never states them.

The **repo name is the plugin name on release** — an agent declares
`{owner, name, version}` and the laboratory host fetches
`github.com/<owner>/<name>` at the `v`-prefixed tag.

> A registration trio must match **byte for byte**. `v0.1.0` ≠ `0.1.0`, and a
> mismatch is **silent** — it builds from GitHub as though nothing were
> registered.

## Layout

This is a **viewer-only** plugin, so the plugin root is the repo root and
`viewer.development.output` is `dist`. (`scaffold.sh` only emits both halves;
the viewer scaffold was copied by hand, which its own README documents as
supported.)

```
objectiveai.json   the manifest — viewer half only
Containerfile      the release build; the laboratory host runs this
build.mjs          the ONE build: pnpm build, pnpm dev, and the Containerfile
src/               phosphene.tsx (the tab), phosphene.css, tokens.css, transport.ts
docs/              platform research, spikes, and the legacy postmortem
```

## The contracts that bite

Three things fail **silently** if you get them wrong. All three are asserted in
CI (`pnpm run check:contracts`).

1. **React must stay external** in the tab bundle. The host serves one React
   instance through the import map in its `tab.html`; a bundle carrying its own
   copy dies on the first hook. Nothing upstream enforces this — the laboratory
   says outright that it is "the ONE invariant we cannot enforce."
2. **Every path the manifest declares must exist in the output.** A missing
   `module` or `styles` entry fails the release build and 404s in development.
3. **Stylesheets only work through the manifest's `styles` array.** A bundler
   strips `import "./x.css"` from a JS entry, so nothing would ever request it.

## Docs

`docs/` is maintained, not written once. Each artifact carries the SHA it was
read at, so it can be re-derived when the platform moves — and on a platform
this young, it will.

| | |
|---|---|
| `why-rebuild.md` | the brief |
| `platform/00-what-this-is.md` | swarms, functions, profiles, the error taxonomy |
| `platform/01-viewer.md` | what a plugin tab actually is |
| `platform/02-plugin-contract.md` | the manifest, the build, the command surface |
| `platform/03-changelog.md` | recency, breakage rate, where the next break lands |
| `spikes/00-boot-check.md` | the scaffold, stood up end to end |
| `spikes/01-calibration.md` | executor, concurrency, styling, rasterizing, persistence |
| `legacy/00-the-old-app.md` | what the previous phosphene was, and what survives |

## Platform

Requires ObjectiveAI **≥ 2.2.15**. Earlier releases cannot render any plugin tab
— every entry chunk shipped with its exports stripped. That was found here and
fixed upstream in [ObjectiveAI#302](https://github.com/ObjectiveAI/objectiveai/pull/302).
