#!/usr/bin/env bash
# List live agent instances so a wedged or orphaned run is visible in one
# command. Exists because of the 2026-08-03 incident: stopping a CLI process
# does NOT stop its daemon-side agent — the spawn ran on for ~9 minutes,
# contending the Claude lane and inflating "active agents" with nothing
# visible anywhere.
set -euo pipefail
echo "── live agent instances (daemon view) ──"
objectiveai agents instances me 2>/dev/null || true
# The viewer's own agents tab is the richer view; this is the headless one.
# `instances list` requires explicit --target instance=<leaf> entries; with a
# leaf from the viewer's agents tab or a spawn's first stream line:
#   objectiveai agents instances list --target instance=<leaf>
#   objectiveai agents wait --agent-instance <aih> --inactive --timeout 30s
echo
echo "Cancelling a run you own: break its stream (close the tab / ctrl-C the"
echo "CLI that spawned it). There is no server-side kill by id at 2.2.15."
