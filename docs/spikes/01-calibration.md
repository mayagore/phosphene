# Calibration spikes A–E + parked-tab throttling

> **Ran:** 2026-08-01, against installed **v2.2.15** (our release).
> **Method:** a purpose-built plugin tab registered in development mode, reporting
> through `console.*` — which `capture.js` forwards to the viewer's log inbox
> under the tab's title. That is the only telemetry channel a plugin gets for
> free, and it doubles as a test harness.
> **Harness:** WebKit 605.1.15, viewport 1024×696, dpr 2.

**Summary**

| Spike | Verdict |
|---|---|
| **A. Executor** | ✅ **Works, including real inference** — `Client.viewer(transport)` reaches the daemon (9–12 ms) *and* drives a live agent completion from a plugin tab. Gap closed 2026-08-01. |
| **B. Concurrency** | ✅ **Concurrent** — 8 calls: 28 ms serial vs 8 ms parallel, 3.5× speedup. The single-in-flight constraint is gone, measured. |
| **C. Styling** | ✅ Answered — we inherit the viewer's theme wholesale, *including its Tailwind utilities*. One hazard found. |
| **D. Rasterize** | ✅ **YES — in-page DOM rasterization works, untainted.** Reverses the practical conclusion of Pass 2 §8. |
| **E. Persistence** | ✅ `localStorage` works, on a **shared** `tauri://localhost` origin. Namespacing is mandatory. |
| **Parked tabs** | ✅ **Not throttled** — 60 fps and on-schedule timers while parked. |

---

## A — Executor

```
A.transport      built
A.clientMode     viewer
A.roundTripMs    9–12
A.itemCount      0
A.VERDICT        executor plumbing WORKS from a plugin tab
```

`Client.viewer(transport)` resolves to mode `viewer`, and a real
`functionsListExecute` round trip completes cleanly through
SDK → Tauri IPC → `daemon_execute` → daemon → response stream. `itemCount: 0`
is an empty result (no functions registered in this state), **not** an error —
the stream closed without an error item, which is the proof.

### Inference half — closed 2026-08-01

An OpenRouter key was configured (`objectiveai api config openrouter-authorization`)
and a **real agent completion ran from inside a plugin tab**:

```
A2.client           viewer mode built
A2.chunk            "Viewer/6JSFmNWghnguySl3M1Lgt0-Dq1akF1w22w1wqGJZ"
A2.spawnMs          930
A2.itemCount        5
A2.aih              Viewer/6JSFmNWghnguySl3M1Lgt0-Dq1akF1w22w1wqGJZ
→ agents logs open --id 63   {"type":"text","text":"pong"}
```

`agentsSpawnExecuteStreaming` through `Client.viewer(transport)` streamed five
chunks in 930 ms, and the assistant response persisted and read back as `"pong"`.
Agent: `openai/gpt-4o-mini`, `temperature: 0`, `max_tokens: 8` — cost negligible.

Three things this settles beyond "it works":

- **An OpenRouter key alone is sufficient.** No ObjectiveAI `apk_` key was
  needed; the hosted default accepted the request with only
  `openrouter_authorization` set. That was an open question in §"what upstream
  intends".
- **The viewer stamps its own identity.** The AIH is `Viewer/…`, not `daemon/…`
  — confirming Pass 2 §11's reading that `daemon_proxy` injects the viewer's
  agent identity server-side and the webview never holds it.
- **Reading results back is a second round trip, and it races.** The first
  `agentsLogsListExecute` returned only the user row; the assistant row landed
  moments later. Anything phosphene builds on logged rows must poll or subscribe,
  not read once after the stream ends.

**Still not run:** a full *function execution* (`functionsExecuteStandard…` /
`…SwissSystem…`), which is what phosphene's review would actually use. That needs
a published function and a swarm, not just an agent — a §6-shaped task rather
than a calibration one. The transport, streaming, identity, and persistence
underneath it are now all verified.

**Wire shape, for reuse** — taken from the published JSON schemas, not guessed:

```json
{ "agent":   { "by": "ref", "agent": { "Resolved": { "upstream": "openrouter", "model": "…" } } },
  "message": { "Simple": "…" },
  "timeout_seconds": 90 }
```

## B — Concurrency

```
B.result   {"n":8,"serialMs":28,"concurrentMs":8,"speedup":3.5,"perCallSerialMs":3.5}
B.VERDICT  CONCURRENT — the single-in-flight constraint is gone
```

Eight identical read-only commands, serial then parallel. **3.5× speedup**
confirms the calls genuinely overlap — the old app's single-in-flight bridge has
no equivalent here.

**Read this carefully.** These are ~3.5 ms local IPC round trips, so the
measurement is dominated by fixed overhead and 3.5× (not 8×) reflects that floor,
not a concurrency cap. It proves *the transport does not serialize*. It does
**not** establish a parallelism budget for long-running inference streams — that
is server-side and remains unmeasured, for the same missing-key reason as A.

## C — Styling

```
C.inherited       fontFamily "Geist Variable", system-ui, sans-serif
                  fontSize 13px  lineHeight 19.5px  color rgb(214,211,209)
                  boxSizing border-box  margin 0px  padding 0px
C.colorScheme     dark
C.bodyBackground  rgb(12, 10, 9)          // --color-ground #0c0a09
C.bodyDisplay     flex
C.themeTokens     ground #0c0a09, copperMid #d97706, infoBright #d6d3d1,
                  fontSans "Geist Variable", radiusMd 6px
C.stylesheetCount 3
```

Everything Pass 2 §5 predicted from source is confirmed live. **The `@theme`
tokens are readable from a plugin tab** — a plugin can consume the viewer's
palette without redefining it.

**The finding source could not give us:**

```
C.tailwindUtilityFlexWorks  true
C.tailwindUtilityP4Works    true
```

Pass 2 predicted a plugin would need its own Tailwind build because "the utility
classes actually present are only those the viewer's own scan generated." That is
technically true but the *practical* conclusion was wrong: common utilities like
`flex` and `p-4` **do work**, because the viewer's own source uses them.

> **This is a trap, not a gift.** A plugin that leans on the viewer's leaked
> utilities is depending on which classes the viewer happens to use *today*. A
> refactor upstream silently deletes them and phosphene's layout breaks with no
> error. **Phosphene must ship its own stylesheet and never rely on an inherited
> utility.** Tokens are safe to consume (they are declared API-ish, in `@theme`);
> utilities are not.

Spike C's original question is settled — the remaining choice is **adopt /
extend / override**, with `color-scheme: dark` and the `#0c0a09` boot flash
fixed regardless.

## D — Rasterize

```
D.canvas2d.toDataURL        data:image/png;base64,iVBORw0K…
D.foreignObject.imageLoaded 120x40
D.foreignObject.RASTERIZED  2042 bytes, data:image/png;base64,…
D.OffscreenCanvas           true
D.createImageBitmap         true
D.canvasToBlob              true
D.getDisplayMedia           false
```

**The SVG `foreignObject` → `Image` → `canvas.drawImage` → `toDataURL` round trip
succeeds and the canvas is NOT tainted.** A plugin tab can rasterize DOM content
to a PNG data URL entirely in-page.

This materially changes Pass 2 §8's conclusion. The *host* offers no
rasterization — that stands, and `getDisplayMedia` is false — but **phosphene
does not need the host to.** It generates HTML; it can render that HTML and
capture it itself.

Caveats to design against, none of them tested here: `foreignObject` rasterizing
is the technique `html2canvas` and friends wrap, and it historically struggles
with external images, non-inlined fonts, and cross-origin resources. Phosphene's
generated designs would need self-contained markup — inlined fonts and
data-URI images — which is a constraint on the *generator*, not a blocker.

**Vision-based review is back on the table.** It should inform §6.1 and §6.3:
this weakens the argument that phosphene needs an MCP half purely to see its own
output.

## E — Persistence

```
E.origin                     tauri://localhost
E.href                       tauri://localhost/tab.html
E.localStorage.write         ok
E.localStorage.readback      {"at":1785558758553,"from":"plugin-tab"}
E.localStorage.totalKeys     1
E.localStorage.foreignKeys   []
E.sessionStorage             ok
E.indexedDB                  true
E.cookieEnabled              true
E.storageManager             true
```

`localStorage` works, as does `sessionStorage` and `indexedDB`. Pass 2 §11's
worry that `core:default` (no `fs` permission) would leave nothing was misplaced
— the web platform storage is all there.

**But the origin is `tauri://localhost`, shared by every tab in the viewer.**
Today `foreignKeys` is empty — the viewer itself stores nothing there, so no
collision exists *right now*. That is a fact about today, not a guarantee:

> Every plugin tab, every built-in tab, and the chrome share one origin and one
> `localStorage`. **Phosphene must namespace every key** (`phosphene.*`) and must
> not assume exclusivity. A second plugin doing the same naively would collide.

`indexedDB` is the better choice for anything non-trivial — it has real
databases as a namespace boundary, rather than one flat keyspace.

## Parked-tab throttling (the spike added after Pass 2)

Deterministic method: the probe tab opens a *sibling* tab, which activates the
sibling and parks the probe. Each window is measured independently.

```
A_active_0to15s        rafPerSec 60    timer100msPerSec 9.6  hidden false
siblingOpened          (this tab is now parked)
B_afterSibling_16to45s rafPerSec 60    timer100msPerSec 9.6  hidden false
C_afterSibling_45to90s rafPerSec 60    timer100msPerSec 9.6  hidden false
```

**A parked background tab is not throttled at all** — full 60 fps, timers on
schedule, and `document.hidden` stays **false**. This confirms Pass 2 §1 exactly:
the shell parks tabs far offscreen rather than calling `hide()`, and WKWebView
does not treat an offscreen-but-unhidden webview as hidden.

**However** — an earlier, non-deterministic run *did* show throttling once
`visibilitychange → hidden` fired: rAF fell to ~7/s and 100 ms timers to ~2/s
within the hidden window. I did not isolate the trigger, but since tab parking is
now ruled out, the remaining candidate is **OS-level window occlusion** (the
viewer window minimized or fully covered).

So the honest rule for phosphene:

| Condition | Throttled? |
|---|---|
| Plugin tab parked in the background, window visible | **No** — full speed |
| Viewer window occluded / minimized | **Yes** — rAF ~7/s, timers ~2/s |

Long-running generation in a background tab is safe. Long-running generation
while the user minimizes the viewer is **not** — anything timer-driven will
crawl. Drive long work off stream events and `await`, never off `setInterval`
pacing, and never assume wall-clock progress.

---

## What this changes for phosphene

1. **Generation can fan out.** Spike B settles the client side; the old
   single-in-flight design has no reason to survive. The server-side budget is
   still unmeasured.
2. **Design→image is viable in-tab** (D). This is the biggest reversal in the
   set, and it removes one of the strongest arguments for an MCP half.
3. **Ship our own stylesheet, consume only tokens** (C). Inherited utilities are
   a silent-breakage hazard.
4. **Namespace all storage; prefer indexedDB** (E). Shared origin, flat keyspace.
5. **Never pace long work with timers** (parked-tab). Window occlusion throttles
   them even though tab parking does not.
6. **One real gap remains:** no provider key on this machine, so no real function
   execution or agent completion has ever been streamed from a plugin tab.
   Everything structural around it is verified. **This is the first thing to do
   once a key is available**, and it is the last thing standing between us and
   §6.

## Reproducing

The spike harness is a single-file plugin tab
(`src/home.tsx` over the v2.2.15 scaffold, SDK bundled, ~10.8 MB). It is
disposable and lives in the session scratchpad. Rebuilding it is cheap: copy the
scaffold, replace `home.tsx`, trim the manifest to one tab, register, spawn.
