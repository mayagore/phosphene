# Spike 02 — what it is actually like to build an ObjectiveAI plugin today

**Run:** 2026-08-02, on ObjectiveAI 2.2.15 (the current release), macOS 15.6
aarch64, 16 GB RAM / 10 CPUs. Monorepo read at
`ObjectiveAI/objectiveai@649b1d7cf2976036ddcec11d8be1001880d2ca87`.

**Why:** Maya's framing — *"phosphene is the test subject for how easy making
plugins is right now with the most up-to-date versions of all things
ObjectiveAI."* So the friction is not an obstacle to the work; it **is** the
work. Everything below is timed and reproduced.

**Headline:** one blocking defect. **A default `objectiveai laboratories spawn`
provisions a 2 GiB VM, and the official Rust plugin scaffold cannot be built in
it — `rustc` is OOM-killed.** Everything else was smooth or cosmetic.

---

## 1. Standing up the laboratory — better than expected

```
objectiveai laboratories spawn      →  73s, exit 0, {"addresses":["http://127.0.0.1:49630"]}
```

One command. It downloaded podman 5.8.4, created its own `objectiveai` VM
(applehv), booted it, and started the host. Notably **self-contained**: podman
lands in `~/.objectiveai/bin/podman/5.8.4/`, never on `PATH`, and the VM is
named `objectiveai` rather than colliding with a user's own `podman machine`.

The scaffold README's "Once per machine — development plugins always run on the
local host, and it is never auto-spawned" is accurate and the cost is small.

**The ongoing cost is the VM, not the install:** 5 CPUs and (by default) 2 GiB,
resident for as long as you are developing.

## 2. 🔴 The blocking defect — 2 GiB cannot build the scaffold

The scaffold's own dependency tree OOMs during `cargo build --release`:

```
error: could not compile `starlark` (lib)
  process didn't exit successfully: `…rustc --crate-name starlark …` (signal: 9, SIGKILL: kill)
Error: building at STEP "RUN cargo build --release && cp target/release/phosphene /plugin":
  while running runtime: exit status 101
```

`signal: 9` is the OOM killer. `starlark` arrives transitively through
`objectiveai-sdk`; it is not something a plugin author chose or can drop.

**This is not phosphene-specific.** The code that failed was the *unmodified*
`objectiveai-mcp-plugin-scaffold-rs`, renamed and nothing else. The same tree
compiles clean on the host in 47s (`cargo check --release`) and builds a 5.6 MB
binary in 94s — so it is purely the VM's memory ceiling.

**Fix, and it works:**

```bash
export CONTAINERS_HELPER_BINARY_DIR=~/.objectiveai/bin/podman/5.8.4/podman-5.8.4/usr/bin
podman machine stop  objectiveai
podman machine set   --memory 6144 objectiveai
podman machine start objectiveai
```

**Worth telling Ronald.** A first-time plugin author on a Mac follows the
scaffold README exactly and hits an unexplained build failure with no mention of
memory anywhere in the chain. Either `laboratories spawn` should provision more
than podman's 2 GiB default, or the failure should name the cause.

## 3. The failure is four layers away from its cause

What the author actually sees, spawning an agent that declares the plugin:

```
502 MCP connection error: server did not return Mcp-Session-Id header at http://127.0.0.1:49717
  body: -32603 upstream connect failed for client:///mayagore/phosphene/v0.1.0
    ephemeral create: ensure plugin image mayagore/phosphene@v0.1.0
      podman build …: Error: building at STEP "RUN cargo build --release" … exit status 101
```

The innermost frame does name the build step — credit where due — but `exit
status 101` is where it stops. The `SIGKILL` line that identifies this as OOM is
only in podman's own output, which is not surfaced. Reproducing the build by
hand was the only way to see it.

**Second-order cost:** 229 seconds to reach that error, because the build runs
to the point of failure before anything is reported.

## 4. Smaller friction

**Dev registrations live in daemon memory only, and a reboot drops them.**
Confirmed 2026-08-03: after a restart both halves were gone and nothing was
running. Expected rather than a bug — but the failure mode is poor. With the
daemon down, `development plugins viewer list` **returns empty rather than
erroring**, so "the daemon is not running" and "nothing is registered" look
identical. And an unregistered plugin does not fail either — it silently builds
from GitHub as though nothing were registered, which presents as "my edits do
nothing." `scripts/resume.sh` exists for this, and checks the daemon *process*
rather than trusting a command's output.

**One instance is still unexplained.** On 2026-08-02 a registration vanished
mid-session with no reboot, and re-creating it reported `"replaced": false` —
genuinely dropped, not overwritten. The laboratory spawn is the only notable
event in between. The reboot explains 2026-08-03; it does not explain that one.

**A local Claude Code login is required for `upstream: "claude_agent_sdk"`, and
the error when it lapses is misleading.** An expired OAuth token surfaces through
ObjectiveAI as `Claude Code returned an error result: success` — the runner
reports the SDK's `subtype` ("success") rather than its `is_error` / 401. The
real message is only visible by running `claude -p … --output-format json`
directly: *"Failed to authenticate. API Error: 401 OAuth access token has
expired."*

**The vendored podman cannot be driven by hand without help.** Invoking it
directly fails with `could not find "gvproxy"` — it searches
`$BINDIR/../libexec/podman` and friends, not the layout it ships in. Setting
`CONTAINERS_HELPER_BINARY_DIR` fixes it. The laboratory clearly does this
internally; an author debugging a build does not know to.

**`laboratories list --client` prints nothing** while a host is demonstrably
running (the process is up and `spawn` returned its address). Either the empty
result means something non-obvious or it is a bug; either way it is a poor
signal when you are trying to confirm your own setup.

## 4b. ✅ It works end to end — and the gate we feared is not a gate

With the VM at 6 GiB, same code, nothing else changed:

```
podman build mcp                     →  exit 0, 117s
```

Then an agent declaring `plugins: [{mayagore, phosphene, v0.1.0}]`, asked for
a brief:

```
objectiveai agents spawn --agent-file … --simple "Brief: a dating app where
  pickles match on brine compatibility."       →  exit 0, 11s, 0 errors
```

The whole lane fired:

1. the agent emitted **18 `tool_calls` deltas** for `phosphene_invent_directions`;
2. the Rust tool ran **inside its container**;
3. it spawned a **nested agent completion back through the host** via
   `spawn::execute_streaming(&command_executor(), …)`;
4. it returned structured JSON — 3 directions with names, descriptions,
   5-slot palettes, typography and moods, plus the shared states
   `["browse", "matches", "messages"]`;
5. the outer agent reported them.

**The reverse-attach gate never fired.** `objectiveai-api/src/agent/completions/client.rs:1044-1057`
refuses an agent declaring `plugins` when there is no reverse-attached CLI, and
that was the plan's one unsettled blocker. A CLI-spawned agent qualifies. What
opens the gate is `laboratories spawn`, exactly as the scaffold README implies.

### ✅ And from a VIEWER TAB too — 2026-08-03

The version that actually decides phosphene's shape. Maya drove it: brief
*"a livestream mobile app where viewers pick teams"*, `via tools` button.

The tab showed `phosphene_invent_directions` mid-call, live, beside the agent's
own instance id. The run completed, and the viewer's log inbox carries the line
that only prints once the tool returned **and** its JSON parsed:

```
{"source":"phosphene","level":"info","message":"phosphene: via tools — phosphene_invent_directions"}
```

**So the whole lane works over the viewer transport:**

```
tab → daemon_execute (Tauri IPC) → daemon → agent declaring plugins
    → laboratory → phosphene container → tool
    → nested agent completion → structured JSON → back to the tab
```

`ClientObjectiveaiMcpUnavailable` never appeared. **The reverse-attach gate is
not a gate from the viewer either** — what opens it is a running laboratory
host, not the kind of client. Every open question in the plan's Phase 0 is now
answered, and the answer is yes.

The plan's contingency — "if step 3 fails, the plan changes shape" — does not
fire. The tab-as-display architecture is buildable as designed, today, on 2.2.15.

**Two wire facts confirmed empirically**, not just read from source: tool calls
arrive as deltas on **assistant** messages under `tool_calls`, and the result
arrives as a separate message with `role: "tool"` at its own `index` — here
`index: 1`, sharing the assistant's index space. That is exactly the hazard the
viewer's stream folding is written against.

## 5. What went right, and deserves saying

- **`scaffold.sh` is unambiguous about what a plugin is.** One required
  argument, a language, and that language is the MCP half's. Both halves under
  one manifest. There is no viewer-only mode to be tempted by.
- **The framework earns its keep.** Transport, port binding, `initialize`, and
  the command extension are all gone from the author's file. What is left really
  is just the tools.
- **The command executor is the good part.** A tool calling
  `spawn::execute_streaming(&command_executor(), …)` reaches the daemon with the
  host stamping identity — a plugin cannot lie about who it is, and it never
  needs a key. This is the mechanism that makes "do all work through the daemon"
  practical rather than aspirational.
- **Registration is honest about its sharp edge.** The README warns the trio
  must match BYTE FOR BYTE and that a mismatch is silent. It is right to warn:
  `v0.1.0` and `0.1.0` are different keys.

## 6. Our own mistakes, recorded so they are not mistaken for platform faults

- **Raw-string delimiter collision.** The invention prompt contains
  `["#101418", …]`, and `"#` terminates a Rust `r#"…"#` literal. Six confusing
  parse errors (`prefix ff6a3d is unknown`) until the delimiters became `r##"`.
  Nothing to do with ObjectiveAI; every prompt containing hex colours in JSON
  will hit it.
- **`Tools::new(router.into_iter().collect())`** is ambiguous; `Tools::new(router)`
  is what the API wants.

## 7. Deviation from the scaffold, with its reason

`mcp.postgres` is **false** where the scaffold sets `true`. The scaffold needs a
database because its note and credential demo tools write to one — and every one
of those is a `*_deleteme`. Phosphene's tools spawn agent completions and return
what comes back; they store nothing, and `main()` never touches `db`. False means
the host skips injecting the db proxy and publishing its conduit port.

## 8. Timings, collected

| Step | Time |
|---|---|
| `laboratories spawn` (incl. podman download + VM boot) | 73s |
| `cargo check --release`, host, cold | 47s |
| `cargo build --release`, host | 94s |
| Agent call → OOM failure reported | 229s |
| VM memory change (stop / set / start) | ~30s |
| `podman build mcp` at 6 GiB, warm caches | 117s |
| Agent → tool → nested agent → structured result | 11s |
