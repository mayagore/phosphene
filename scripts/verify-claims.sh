#!/usr/bin/env bash
# Re-check what this repo CLAIMS about the ObjectiveAI CLI against what it does.
#
# WHY THIS EXISTS. On 2026-08-07 four recorded "the instrument is broken"
# findings turned out to be one usage error: passing the joined hierarchy as
# `instance=` fabricates a target that never ran, and the daemon zero-fills it.
# That single mistake became a doc section, a script comment, and two confused
# questions to Ronald. Prose cannot catch that. A command can.
#
#   bash scripts/verify-claims.sh              # tiers A + B — read-only, no cost
#   bash scripts/verify-claims.sh --fast       # skip the one 4s timing check
#   bash scripts/verify-claims.sh --strict     # doc drift becomes a failure
#   bash scripts/verify-claims.sh --fixture <AIH>   # pin the instance to probe
#
# Checks assert VERIFIED REALITY, not the docs. One that contradicts something
# still written down carries CORRECTS= and lands in the DOC DRIFT block; when
# that block is empty the docs have caught up and --strict can gate.
#
# Deliberately NOT in CI: a GitHub runner has no daemon and no objectiveai
# binary, so every check would skip and the job would pass green having tested
# nothing. That silent-success shape is the thing resume.sh was written against.
#
# Scope: the CLI read path. The SDK wire shapes the viewer consumes (spawn
# stream items, the delta protocol) are a separate instrument — a Node harness
# under viewer/scripts/ using the SDK's exported Zod schemas. Not this script.

set -euo pipefail

# Load-bearing: under zsh's MULTIOS, `cmd 2>&1 1>/dev/null` DUPLICATES the
# stream rather than redirecting it, which makes the "errors go to stdout"
# check pass for the wrong reason.
[ -n "${BASH_VERSION:-}" ] || { echo "run this under bash, not zsh" >&2; exit 1; }

FAST=false; STRICT=false; FIXTURE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --fast)    FAST=true ;;
    --strict)  STRICT=true ;;
    --fixture) FIXTURE="${2:-}"; shift ;;
    *) echo "unknown flag: $1" >&2; exit 1 ;;
  esac
  shift
done

say()  { printf '  %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
die()  { printf '  \033[31mfail\033[0m  %s\n' "$*" >&2; exit 1; }

PASS=0; FAIL=0; SKIP=0
DRIFT=()

# check <id> <doc-anchor> <label>  — then set EXPECT/ACTUAL/CMD, call verdict
ID=""; DOC=""; LABEL=""; EXPECT=""; ACTUAL=""; CMD=""; CORRECTS=""; CORRECTS_FILE=""
check() { ID="$1"; DOC="$2"; LABEL="$3"; EXPECT=""; ACTUAL=""; CMD=""; CORRECTS=""; CORRECTS_FILE=""; }

# corrects <file> <extended-regex> <what the file used to claim>
#
# Drift is reported only while the wrong text is STILL THERE. Fix the file and
# the entry disappears on the next run with no edit here — a hardcoded list
# would rot into exactly the stale-prose problem this script exists to catch.
#
# Blockquoted lines are skipped: the convention for correcting a claim is to
# quote the old wording in a `>` block above the new text, and matching that
# retraction would make every fixed claim look permanently broken.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
corrects() {
  CORRECTS=""
  if [ -f "$REPO_ROOT/$1" ] && grep -v '^ *>' "$REPO_ROOT/$1" | grep -Eq "$2"; then
    CORRECTS="$1 — $3"
  fi
}

verdict() {
  # Every branch must end on a command that succeeds: a trailing `[ ] &&` that
  # evaluates false makes the function return 1, and `set -e` kills the run.
  local mark=""
  if [ -n "$CORRECTS" ]; then mark="  ✱"; fi
  if [ "$ACTUAL" = "$EXPECT" ]; then
    PASS=$((PASS+1))
    printf '  \033[32mpass\033[0m  %-5s %-56s %s%s\n' "$ID" "$LABEL" "$DOC" "$mark"
    if [ -n "$CORRECTS" ]; then DRIFT+=("$ID|$CORRECTS|$ACTUAL"); fi
  else
    FAIL=$((FAIL+1))
    printf '  \033[31mFAIL\033[0m  %-5s %-56s %s\n' "$ID" "$LABEL" "$DOC"
    printf '        expected: %s\n        actual:   %s\n        cmd:      %s\n' \
      "$EXPECT" "$ACTUAL" "$CMD"
  fi
}

skip() { SKIP=$((SKIP+1)); printf '  \033[90mskip\033[0m  %-5s %-56s %s\n' "$ID" "$1" "$DOC"; }

OAI() { objectiveai "$@" 2>/dev/null; }
helptext() { OAI "$@" --help | jq -r .help; }
subcommands() { helptext "$@" | sed -n '/^Commands:/,/^$/p' | awk 'NF && $1!="Commands:" && $1!="help" {print $1}' | sort | tr '\n' ' '; }

# ── 0. Environment ──────────────────────────────────────────────────────
command -v objectiveai >/dev/null || die "objectiveai is not on PATH — add ~/.objectiveai/bin"
command -v jq >/dev/null          || die "jq is required (macOS ships it at /usr/bin/jq)"

VER="$(OAI --version | jq -r .help | awk '{print $2}')"
printf '\nphosphene verify-claims — objectiveai %s\n' "$VER"
[ "$VER" = "2.2.15" ] || warn "claims here were recorded at 2.2.15 — treat every pass as re-earned"

# ── A. Architecture gates — no daemon, no cost ──────────────────────────
printf '\n── A · architecture gates (no daemon, zero cost) ──\n'

check A1 "HANDOFF.md:170" "swarms exposes only get|list|publish"
CMD="objectiveai swarms --help"; EXPECT="get list publish "; ACTUAL="$(subcommands swarms)"; verdict

check A2 "HANDOFF.md:134" "no top-level vector command group"
CMD="objectiveai vector --help"; EXPECT="absent"
ACTUAL="$(OAI vector --help >/dev/null 2>&1 && echo present || echo absent)"; verdict

check A3 "HANDOFF.md:172" "top_logprobs is documented vector-only"
CMD="objectiveai agents spawn request-schema | jq …top_logprobs.description"; EXPECT="yes"
ACTUAL="$(OAI agents spawn request-schema \
  | jq -r '[.["$defs"][]?.properties?.top_logprobs?.description // empty] | join(" ")' \
  | grep -qi 'vector completions only' && echo yes || echo no)"; verdict

check A4 "scripts/agents-sweep.sh:7" "instances me is gone at this version"
CMD="objectiveai agents instances --help"; EXPECT="get list "; ACTUAL="$(subcommands agents instances)"; verdict

check A5 ".agents/skills/agent-control/SKILL.md:91" "logs list requires exactly one of --all/--pending"
CMD="objectiveai agents logs list --target 'instance=x,parent=y'"; EXPECT="rejected"
ACTUAL="$(OAI agents logs list --target "instance=x,parent=y" >/dev/null 2>&1 && echo accepted || echo rejected)"; verdict

check A6 ".agents/skills/agent-control/SKILL.md:87" "parent defaults to the caller's own AIH when omitted"
CMD="objectiveai agents logs list --help"; EXPECT="documented"
ACTUAL="$(helptext agents logs list | grep -qi "defaults to the cli's own" && echo documented || echo absent)"; verdict

check A7 ".agents/skills/agent-control/SKILL.md:40" "agents spawn returns a bare string"
CMD="objectiveai agents spawn response-schema | jq -r .type"; EXPECT="string"
ACTUAL="$(OAI agents spawn response-schema | jq -r '.type // "?"')"; verdict

check A8 "HANDOFF.md:256" "a logged error row REQUIRES error — 'error: null' is not a shape"
corrects HANDOFF.md 'a not-found row\s*$|has \`error: null\`' "claimed a not-found row has error: null"
CMD="objectiveai agents logs open response-schema"; EXPECT="required"
ACTUAL="$(OAI agents logs open response-schema \
  | jq -r '[.. | objects | select((.required? // []) | index("error")) ] | if length > 0 then "required" else "optional" end')"; verdict

# ── B. Read path against existing daemon state ─────────────────────────
printf '\n── B · read path (daemon state, zero inference) ──\n'

DAEMON_UP=false
if pgrep -f "objectiveai-daemon daemon spawn" >/dev/null 2>&1; then
  ME="$(OAI agents instances get --target me | jq -r '.agent_instance_hierarchy // empty')"
  [ -n "$ME" ] && DAEMON_UP=true
fi

if [ "$DAEMON_UP" != true ]; then
  ID=""; DOC=""
  if pgrep -f "objectiveai-daemon daemon spawn" >/dev/null 2>&1; then
    warn "daemon process is up but not answering reads — wedged. Tier B skipped."
  else
    say "daemon is not running — tier B skipped. Bring it up: bash scripts/resume.sh"
  fi
  SKIP=$((SKIP+18))
else
  # Fixture: the most recently active finished instance with real log rows.
  # Discovered, not pinned, so this keeps working as state churns.
  pick() { OAI agents instances list --all | jq -rs --arg pat "$1" '
      map(select(.queued == 0 and .logged >= 2 and (.agent_instance_hierarchy | test("/"))
                 and (if $pat == "" then true else (.agent_instance_hierarchy | startswith($pat)) end)))
      | sort_by(.last_active_at) | last | .agent_instance_hierarchy // empty'; }

  AIH="${FIXTURE:-$(pick "")}"
  AIH_CLI="$(pick "cli/")"

  if [ -z "$AIH" ]; then
    ID=""; DOC=""
    say "no finished run in daemon state to probe — tier B skipped"
    SKIP=$((SKIP+18))
  else
    LEAF="${AIH##*/}"; PARENT="${AIH%/*}"
    LOGGED="$(OAI agents instances get --target "instance=$LEAF,parent=$PARENT" | jq -r '.logged // -1')"
    say "fixture  $AIH  (logged $LOGGED)"
    printf '\n'

    check B1 "scripts/agents-sweep.sh:37" "instances list --all is NDJSON with the four fields"
    CMD="objectiveai agents instances list --all"
    EXPECT="ok"
    ACTUAL="$(OAI agents instances list --all | jq -e -s 'length > 0 and all(has("last_active_at") and has("queued") and has("logged") and has("agent_instance_hierarchy"))' >/dev/null && echo ok || echo bad)"; verdict

    check B2 "HANDOFF.md:246" "instances get agrees with instances list on logged"
    corrects HANDOFF.md 'reports .\*logged: 0.\* for runs' "claimed instances get reports logged: 0 for runs that executed"
    CMD="objectiveai agents instances get --target \"instance=\$LEAF,parent=\$PARENT\""
    LIST_LOGGED="$(OAI agents instances list --all | jq -rs --arg a "$AIH" 'map(select(.agent_instance_hierarchy == $a)) | last | .logged // -1')"
    EXPECT="$LIST_LOGGED"; ACTUAL="$LOGGED"; verdict

    check B3 "HANDOFF.md:247" "logs list with a SPLIT target and --all returns rows"
    corrects HANDOFF.md 'returns zero rows\s*$|zero rows in every target form' "claimed logs list returns zero rows in every target form"
    CMD="objectiveai agents logs list --target \"instance=\$LEAF,parent=\$PARENT\" --all"
    ROWS="$(OAI agents logs list --target "instance=$LEAF,parent=$PARENT" --all | grep -c . || true)"
    EXPECT="yes"; ACTUAL="$([ "$ROWS" -gt 0 ] && echo yes || echo no)"; verdict

    check B4 "HANDOFF.md:247" "--pending is empty for a FINISHED run, exit 0"
    CMD="… logs list --target \"instance=\$LEAF,parent=\$PARENT\" --pending"
    P="$(OAI agents logs list --target "instance=$LEAF,parent=$PARENT" --pending | grep -c . || true)"
    EXPECT="0"; ACTUAL="$P"; verdict

    check B5 "(invariant)" "logged == sum(parts) + 1"
    CMD="… logs list … --all | jq -s '[.[].parts|length]|add'"
    PARTS="$(OAI agents logs list --target "instance=$LEAF,parent=$PARENT" --all | jq -s '[.[].parts | length] | add // 0')"
    EXPECT="$LOGGED"; ACTUAL="$((PARTS + 1))"; verdict

    check B6 ".agents/skills/agent-control/SKILL.md:80" "the JOINED form returns nothing, exit 0"
    CMD="… logs list --target \"instance=\$AIH\" --all   # the mistake"
    J="$(OAI agents logs list --target "instance=$AIH" --all | grep -c . || true)"
    EXPECT="0"; ACTUAL="$J"; verdict

    check B7 "HANDOFF.md:246" "the JOINED form is what fabricates a zero-filled target"
    corrects HANDOFF.md 'most instruments lie' "framed the zero-fill as the instruments lying"
    CMD="objectiveai agents instances get --target \"instance=\$AIH\""
    EXPECT="$ME/$AIH 0"
    ACTUAL="$(OAI agents instances get --target "instance=$AIH" | jq -r '[.agent_instance_hierarchy, (.logged|tostring)] | join(" ")')"; verdict

    check B8 ".agents/skills/agent-control/SKILL.md:30" "parent= is ABSOLUTE, not caller-relative"
    corrects .agents/skills/agent-control/SKILL.md 'CLI prepends its own AIH\s*$|prepends its own AIH.\*to whatever' "claimed the CLI prepends its own AIH to parent="
    CMD="instances get with parent=\$PARENT vs parent=\$ME/\$PARENT"
    A="$(OAI agents instances get --target "instance=$LEAF,parent=$PARENT"     | jq -r '.logged')"
    B="$(OAI agents instances get --target "instance=$LEAF,parent=$ME/$PARENT" | jq -r '.logged')"
    EXPECT="differ"; ACTUAL="$([ "$A" != "$B" ] && echo differ || echo same)"; verdict

    check B9 ".agents/skills/agent-control/SKILL.md:126" "--target me is a strict subset of --all"
    CMD="instances list --target me | wc -l   vs   --all | wc -l"
    N_ME="$(OAI agents instances list --target me | grep -c . || true)"
    N_ALL="$(OAI agents instances list --all | grep -c . || true)"
    EXPECT="yes"; ACTUAL="$([ "$N_ME" -lt "$N_ALL" ] && echo yes || echo no)"; verdict

    check B10 "scripts/agents-sweep.sh:11" "--all surfaces roots that --target me cannot"
    CMD="instances list --all | roots"
    ROOTS="$(OAI agents instances list --all | jq -r '.agent_instance_hierarchy // empty | split("/")[0]' | sort -u | tr '\n' ' ')"
    EXPECT="yes"; ACTUAL="$([ "$(printf '%s' "$ROOTS" | wc -w)" -gt 1 ] && echo yes || echo no)"
    if [ "$ACTUAL" = "yes" ]; then LABEL="$LABEL [${ROOTS% }]"; fi
    verdict

    check B11 "HANDOFF.md:251" "logs open --id returns part content"
    CMD="objectiveai agents logs open --id <max part id>"
    PID="$(OAI agents logs list --target "instance=$LEAF,parent=$PARENT" --all | jq -s '[.[].parts[].id] | max // empty')"
    if [ -n "$PID" ]; then
      EXPECT="content"
      ACTUAL="$(OAI agents logs open --id "$PID" | jq -r 'if .type == "error" then "error" else "content" end')"; verdict
    else
      skip "fixture has no part ids"
    fi

    check B12 "HANDOFF.md:256" "not-found has NO error key at all, exit 1"
    corrects HANDOFF.md 'a not-found row\s*$|has \`error: null\`' "claimed a not-found row has error: null"
    CMD="objectiveai agents logs open --id 999999999"
    NF="$(OAI agents logs open --id 999999999 || true)"
    EXPECT="error,no-error-key"
    ACTUAL="$(printf '%s' "$NF" | jq -r '[(.type // "?"), (if has("error") then "has-error-key" else "no-error-key" end)] | join(",")')"; verdict

    check B13 ".agents/skills/agent-control/SKILL.md:130" "instances get answers for a nonexistent id, without an agent block"
    CMD="objectiveai agents instances get --target instance=phosphene-verify-nonexistent"
    EXPECT="no-agent"
    ACTUAL="$(OAI agents instances get --target "instance=phosphene-verify-nonexistent" | jq -r 'if has("agent") then "has-agent" else "no-agent" end')"; verdict

    check B14 ".agents/skills/agent-control/SKILL.md:137" "wait --inactive returns Ok for an id that never existed"
    CMD="objectiveai agents wait --agent-instance phosphene-verify-nonexistent --inactive --timeout 5s"
    EXPECT="Ok"
    ACTUAL="$(OAI agents wait --agent-instance "phosphene-verify-nonexistent" --inactive --timeout 5s | jq -r '. // "?"' | tr -d '"')"; verdict

    check B15 "HANDOFF.md:262" "wait --inactive returns IMMEDIATELY, it does not burn the timeout"
    corrects HANDOFF.md 'consume its entire timeout' "claimed wait --inactive consumes its entire timeout"
    CMD="time objectiveai agents wait … --inactive --timeout 10s"
    T0=$SECONDS
    OAI agents wait --agent-instance "phosphene-verify-nonexistent" --inactive --timeout 10s >/dev/null || true
    EXPECT="fast"; ACTUAL="$([ $((SECONDS - T0)) -le 2 ] && echo fast || echo slow)"; verdict

    check B16 "HANDOFF.md:262" "wait --active IS the one that burns the timeout"
    if [ "$FAST" = true ]; then
      skip "--fast"
    else
      CMD="time objectiveai agents wait … --active --timeout 4s"
      T0=$SECONDS
      OAI agents wait --agent-instance "phosphene-verify-nonexistent" --active --timeout 4s >/dev/null || true
      EXPECT="slow"; ACTUAL="$([ $((SECONDS - T0)) -ge 3 ] && echo slow || echo fast)"; verdict
    fi

    check B17 "HANDOFF.md:247" "logs list --target me is empty because the CLI is not an agent"
    CMD="objectiveai agents logs list --target me --all"
    M="$(OAI agents logs list --target me --all | grep -c . || true)"
    EXPECT="0"; ACTUAL="$M"; verdict

    check B18 "scripts/agents-sweep.sh:34" "errors arrive as JSON on STDOUT, stderr empty, exit 1"
    CMD="objectiveai agents logs open --id 999999999   # stdout vs stderr"
    OUT="$(OAI agents logs open --id 999999999 || true)"
    ERR="$( { objectiveai agents logs open --id 999999999 >/dev/null; } 2>&1 || true )"
    EXPECT="json-stdout,empty-stderr"
    ACTUAL="$(printf '%s' "$OUT" | jq -e 'has("type")' >/dev/null 2>&1 && printf 'json-stdout' || printf 'not-json')"
    ACTUAL="$ACTUAL,$([ -z "$ERR" ] && echo empty-stderr || echo stderr-used)"; verdict

    # Registration / lifecycle is resume.sh's instrument. A second copy would
    # drift from it, which is the failure docs/reviews/01-intention.md calls M1.
    printf '\n── B · registration state (delegated to resume.sh --check) ──\n'
    bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/resume.sh" --check 2>&1 | sed -n '/^  /p' || true
  fi
fi

# ── Report ─────────────────────────────────────────────────────────────
if [ ${#DRIFT[@]} -gt 0 ]; then
  printf '\n── doc drift · verified behaviour contradicts the written record ──\n'
  for d in "${DRIFT[@]}"; do
    printf '  %-5s %s\n' "${d%%|*}" "$(printf '%s' "$d" | cut -d'|' -f2)"
  done
  printf '\n  Fix the text, then re-run. --strict turns this block into exit 2.\n'
fi

printf '\n%d pass · %d fail · %d skip · %d doc-drift\n\n' "$PASS" "$FAIL" "$SKIP" "${#DRIFT[@]}"

if [ "$FAIL" -gt 0 ]; then exit 1; fi
if [ "$STRICT" = true ] && [ ${#DRIFT[@]} -gt 0 ]; then exit 2; fi
exit 0
