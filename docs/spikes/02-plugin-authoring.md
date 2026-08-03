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

**The dev registration vanished mid-session.** `development plugins viewer list`
returned phosphene early on, then returned empty later, with no action taken
against it in between. Re-creating it reported `"replaced": false`, confirming
it had genuinely been dropped rather than overwritten. The laboratory spawn is
the only notable event in between. Unexplained; worth watching for.

**The vendored podman cannot be driven by hand without help.** Invoking it
directly fails with `could not find "gvproxy"` — it searches
`$BINDIR/../libexec/podman` and friends, not the layout it ships in. Setting
`CONTAINERS_HELPER_BINARY_DIR` fixes it. The laboratory clearly does this
internally; an author debugging a build does not know to.

**`laboratories list --client` prints nothing** while a host is demonstrably
running (the process is up and `spawn` returned its address). Either the empty
result means something non-obvious or it is a bug; either way it is a poor
signal when you are trying to confirm your own setup.

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
