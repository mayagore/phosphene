#!/usr/bin/env bash
# Bring phosphene up from cold. Safe to run twice.
#
# WHY THIS EXISTS. Dev plugin registrations live in the daemon's memory, not on
# disk, so anything that ends the daemon — a reboot, `daemon kill`, a crash —
# drops them. The plugin then silently builds from GitHub as though nothing were
# registered, which looks like "my edits do nothing" rather than like an error.
# Re-registration belongs in a script, not in someone's memory.
#
#   bash scripts/resume.sh            # bring everything up
#   bash scripts/resume.sh --check    # report state, change nothing
#
# Every step is checked and every failure is loud. A silent fallback is how the
# legacy app's dead-port 500s stayed undiagnosed for weeks.

set -euo pipefail

# The registration trio. It must match BYTE FOR BYTE between the two halves and
# match what an agent declares — `v0.1.0` and `0.1.0` are different keys, and a
# mismatch is silent. One definition here so the two calls cannot drift.
OWNER="mayagore"
NAME="phosphene"
VERSION="v0.1.0"

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

say()  { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m  %s\n' "$*" >&2; exit 1; }

command -v objectiveai >/dev/null || die "objectiveai is not on PATH — add ~/.objectiveai/bin"

printf '\nphosphene resume — %s/%s/%s\n\n' "$OWNER" "$NAME" "$VERSION"

# ── 1. Daemon ───────────────────────────────────────────────────────────
# Nothing auto-spawns it, and with it down the read commands below return an
# EMPTY result rather than an error — so check the process, not the output.
#
# The daemon's ENV matters as much as the process: runner-spawned claude
# subprocesses inherit it, and claude's MCP client otherwise kills any tool
# call that is silent for 60s ("The operation timed out." on every render
# slower than a minute) and bounces oversized results. Export before spawn;
# a daemon started without these must be killed and respawned — env cannot
# be injected into a running process.
export MCP_TOOL_TIMEOUT="${MCP_TOOL_TIMEOUT:-600000}"
export CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT="${CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT:-600000}"
export MAX_MCP_OUTPUT_TOKENS="${MAX_MCP_OUTPUT_TOKENS:-100000}"
if pgrep -f "objectiveai-daemon daemon spawn" >/dev/null 2>&1; then
  ok "daemon already running"
  DPID="$(pgrep -f "objectiveai-daemon daemon spawn" | head -1)"
  if ! ps eww "$DPID" 2>/dev/null | grep -q "MCP_TOOL_TIMEOUT="; then
    warn "running daemon LACKS MCP_TOOL_TIMEOUT — renders >60s will time out."
    say  "  fix:  kill $DPID   # then re-run this script (it exports + respawns)"
  fi
elif $CHECK_ONLY; then
  warn "daemon is NOT running"
else
  say "starting the daemon…"
  objectiveai daemon spawn --timeout 3m >/dev/null 2>&1 || die "daemon spawn failed"
  pgrep -f "objectiveai-daemon daemon spawn" >/dev/null 2>&1 || die "daemon spawn reported success but no daemon is running"
  ok "daemon started"
fi

# ── 2. The podman machine's memory ──────────────────────────────────────
# 2 GiB is podman's default and what `laboratories spawn` accepts. It is NOT
# enough to build the Rust MCP half: rustc is OOM-killed compiling `starlark`,
# and the failure surfaces four layers away as a 502 about a missing
# Mcp-Session-Id header. Checked here so it is named once, cheaply.
# See docs/spikes/02-plugin-authoring.md §2.
PODMAN="$(ls -1d "$HOME"/.objectiveai/bin/podman/*/podman-*/usr/bin/podman 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$PODMAN" ] && [ -x "$PODMAN" ]; then
  export CONTAINERS_HELPER_BINARY_DIR="$(dirname "$PODMAN")"
  MEM_MIB="$("$PODMAN" machine inspect objectiveai --format '{{.Resources.Memory}}' 2>/dev/null | tr -dc '0-9' || true)"
  if [ -z "$MEM_MIB" ]; then
    warn "no 'objectiveai' podman machine yet — laboratories spawn will create one"
  elif [ "$MEM_MIB" -lt 6144 ]; then
    warn "podman machine has ${MEM_MIB} MiB — too small to build the MCP half."
    say  "  fix:  podman machine stop objectiveai"
    say  "        podman machine set --memory 6144 objectiveai"
    say  "        podman machine start objectiveai"
    say  "  (podman is at \$CONTAINERS_HELPER_BINARY_DIR/podman)"
  else
    ok "podman machine ${MEM_MIB} MiB"
  fi
else
  warn "vendored podman not found — laboratories spawn will install it"
fi

# ── 3. Laboratory host ──────────────────────────────────────────────────
# Required for ANY agent that declares `plugins`, and never auto-started. This
# is what opens the gate — not the kind of client (docs/spikes/02 §4b).
if pgrep -f "objectiveai-laboratory" >/dev/null 2>&1; then
  ok "laboratory already running"
elif $CHECK_ONLY; then
  warn "laboratory is NOT running — agents declaring plugins would fail"
else
  say "spawning the laboratory (installs podman on first run, ~75s)…"
  objectiveai laboratories spawn --timeout 30m >/dev/null 2>&1 || die "laboratories spawn failed"
  ok "laboratory spawned"
fi

# ── 4. Both registrations, one directory ────────────────────────────────
# The scaffold registers BOTH halves against the SAME directory — the manifest
# at the root resolves `mcp.containerfile` and `viewer.containerfile` from here.
register() { # register <half>
  local half="$1" listed
  listed="$(objectiveai development plugins "$half" list 2>/dev/null | grep -c "\"name\":\"$NAME\"" || true)"
  if [ "$listed" -gt 0 ]; then
    ok "$half registered"
    return
  fi
  if $CHECK_ONLY; then
    warn "$half is NOT registered"
    return
  fi
  objectiveai development plugins "$half" create \
    --owner "$OWNER" --name "$NAME" --version "$VERSION" --path "$REPO" >/dev/null 2>&1 \
    || die "could not register the $half half"
  ok "$half registered"
}
register mcp
register viewer

# The two trios must be identical. A mismatch does not error anywhere — the
# plugin just builds from GitHub as though nothing were registered.
if ! $CHECK_ONLY; then
  MCP_TRIO="$(objectiveai development plugins mcp list 2>/dev/null | head -1)"
  VIEWER_TRIO="$(objectiveai development plugins viewer list 2>/dev/null | head -1)"
  [ -n "$MCP_TRIO" ] || die "mcp half did not register"
  [ "$MCP_TRIO" = "$VIEWER_TRIO" ] \
    || die "the two halves disagree — a mismatch is SILENT:
    mcp:    $MCP_TRIO
    viewer: $VIEWER_TRIO"
  ok "both halves agree, byte for byte"
fi

# ── 5. The viewer's built output ────────────────────────────────────────
# `viewer.development.output` points at viewer/dist. A missing bundle is a blank
# tab with no error, so build rather than discover that in the UI.
if [ -f "$REPO/viewer/dist/phosphene.js" ] && [ -f "$REPO/viewer/dist/phosphene.css" ]; then
  ok "viewer bundle present"
elif $CHECK_ONLY; then
  warn "viewer bundle MISSING — the tab would render blank"
else
  say "building the viewer half…"
  (cd "$REPO/viewer" && pnpm install --frozen-lockfile >/dev/null 2>&1 && pnpm run build >/dev/null 2>&1) \
    || die "viewer build failed — run 'cd viewer && pnpm run verify' to see why"
  ok "viewer built"
fi

# ── 6. The viewer ───────────────────────────────────────────────────────
if pgrep -f "objectiveai-viewer" >/dev/null 2>&1; then
  ok "viewer already running"
elif $CHECK_ONLY; then
  warn "viewer is NOT running"
else
  say "starting the viewer…"
  nohup objectiveai viewer spawn >/dev/null 2>&1 &
  for _ in $(seq 1 20); do
    sleep 1
    pgrep -f "objectiveai-viewer" >/dev/null 2>&1 && break
  done
  pgrep -f "objectiveai-viewer" >/dev/null 2>&1 || die "the viewer did not come up"
  ok "viewer started"
fi

printf '\n'
if $CHECK_ONLY; then
  say "check only — nothing was changed."
else
  say "Ready. Switch to the phosphene tab; a tab switch picks up a new build."
  say "Watch it work:  tail -f ~/.objectiveai/state/default/viewer/viewer-logs/*.jsonl"
  say "Re-check what the docs claim about the CLI:  bash scripts/verify-claims.sh"
fi
printf '\n'
