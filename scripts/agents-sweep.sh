#!/usr/bin/env bash
# One command to spot wedged or orphaned daemon-side agent runs. Exists because
# of the 2026-08-03 incident: stopping a CLI process does NOT stop its
# daemon-side agent — the spawn ran on for ~9 minutes, contending the Claude
# lane and inflating "active agents" while visible nowhere.
#
# CLI 2.2.15 removed the `instances me` subcommand (the group help still
# mentions it). The surface is now `instances list --target me` (direct
# children of the caller) or `instances list --all` (every instance in daemon
# state). This sweeps --all: the incident was precisely a run no scoped view
# showed, and daemon/-rooted instances only appear under --all.
#
# HONESTY:
# - Daemon state retains completed instances, so presence below does NOT mean
#   running. The wedge signal is recency: run this twice ~30s apart while
#   running nothing yourself — a row whose last_active_at advances is a live
#   daemon-side run. queued > 0 is pending work and flagged separately.
# - The HIERARCHY column is the full joined lineage. To look one up, SPLIT it:
#   the last segment is the instance, everything before it is the parent.
#   Passing the joined string as instance= fabricates a target that never ran,
#   and the daemon zero-fills it — that is where this repo's old "instances get
#   reports logged: 0" and "logs list returns nothing" claims came from. Both
#   commands are fine; the target was not.
#     objectiveai agents logs list --target "instance=<leaf>,parent=<rest>" --all
#     objectiveai agents logs open --id <N>          # part content
#   Exactly one of --all / --pending is required. --pending shows only
#   unfinalized rows, so it is correctly empty for a finished run.
# - To block on one: `agents wait --agent-instance <leaf> --active` waits for it
#   to be up and burns the full timeout if it never is. `--inactive` returns
#   immediately, and returns Ok for an id that never existed — so it confirms
#   nothing on its own.
# The viewer's agents tab is the richer view; this is the headless one.
set -euo pipefail

command -v objectiveai >/dev/null || { echo "objectiveai is not on PATH — add ~/.objectiveai/bin" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required (macOS ships it at /usr/bin/jq)" >&2; exit 1; }

TAIL="${1:-15}"

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Errors come back as JSON on stdout — surface them instead of swallowing.
objectiveai agents instances list --all > "$tmp" || { cat "$tmp" >&2; exit 1; }

rows="$(jq -r '[.last_active_at, .queued, .logged, .agent_instance_hierarchy] | @tsv' "$tmp" | sort)"
total="$(printf '%s\n' "$rows" | grep -c . || true)"

echo "── ${TAIL} most recently active of ${total} instances in daemon state (newest last) ──"
{
  printf 'LAST_ACTIVE\tQUEUED\tLOGGED\tHIERARCHY\n'
  printf '%s\n' "$rows" | tail -n "$TAIL"
} | column -t -s$'\t'

queued="$(printf '%s\n' "$rows" | awk -F'\t' '$2 > 0' || true)"
echo
if [ -n "$queued" ]; then
  echo "!! instances reporting queued work — live or wedged:"
  printf '%s\n' "$queued" | column -t -s$'\t'
else
  echo "no instance reports queued work."
fi

echo
echo "Cancelling a run you own: break its stream (close the tab / ctrl-C the"
echo "CLI that spawned it). There is no server-side kill by id at 2.2.15."
