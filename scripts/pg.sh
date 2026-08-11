#!/usr/bin/env bash
# Query phosphene's plugin postgres, resolving the connection rather than
# remembering it.
#
# WHY THIS EXISTS. On 2026-08-10 a watcher polled a hardcoded port while the
# daemon was restarted underneath it. Postgres moved (59806 → 60238), every
# query failed, and the script's own `2>/dev/null || echo 0` turned each
# failure into a count of zero — so it reported "no boards yet" for a run that
# was working. The reading was not wrong by a little; it was not a reading at
# all.
#
# The two rules this file exists to enforce:
#   1. RESOLVE, never remember. The port is on the live `postgres -D` command
#      line and the daemon picks a new one whenever it restarts.
#   2. A failure is not a zero. Every path below dies loudly rather than
#      emitting an empty result that reads like a real answer. That confusion
#      is this platform's signature failure — `plugins list` returns empty
#      with the daemon down, a bad log target reports `logged: 0` — and it is
#      what `resume.sh` means by "check the process, not the output".
#
#   bash scripts/pg.sh --port                 # just the resolved port
#   bash scripts/pg.sh --schema               # the plugin schema name
#   bash scripts/pg.sh -c "SELECT 1"          # run SQL, tab-separated
#   bash scripts/pg.sh --boards <exploration> # id, index, label, bytes, round

set -euo pipefail

die() { printf '  \033[31mfail\033[0m  %s\n' "$*" >&2; exit 1; }

PSQL=$(ls -d "$HOME"/.objectiveai/bin/pg-bin/*/bin/psql 2>/dev/null | head -1) \
  || die "no psql under ~/.objectiveai/bin/pg-bin"
[ -x "$PSQL" ] || die "no psql under ~/.objectiveai/bin/pg-bin — is the daemon installed?"

# Resolved from the live process, every invocation. Not cached, not defaulted.
PORT=$(ps aux | grep "[p]ostgres -D" | grep -oE -- '-p [0-9]+' | grep -oE '[0-9]+' | head -1)
[ -n "$PORT" ] || die "postgres is not running (no 'postgres -D' process) — start the daemon"

export PGPASSWORD=objectiveai
q() {
  # No 2>/dev/null and no ||: a connection error must reach the caller.
  "$PSQL" -h 127.0.0.1 -p "$PORT" -U postgres -d objectiveai -At "$@"
}

schema() {
  local s
  s=$(q -c "SELECT schema_name FROM information_schema.schemata
            WHERE schema_name LIKE 'plugin_%phosphene%' ORDER BY schema_name LIMIT 1;")
  [ -n "$s" ] || die "no phosphene plugin schema in the daemon's database — has the plugin ever run?"
  printf '%s\n' "$s"
}

case "${1:---help}" in
  --port)   printf '%s\n' "$PORT" ;;
  --schema) schema ;;
  -c)       [ $# -ge 2 ] || die "-c needs SQL"; q -F $'\t' -c "$2" ;;
  --boards)
    [ $# -ge 2 ] || die "--boards needs an exploration_id"
    S=$(schema)
    q -F $'\t' -c "SELECT direction_index, label, length(html), round
                   FROM \"$S\".phosphene_artboards
                   WHERE exploration_id = '$2'
                   ORDER BY direction_index, label;"
    ;;
  *) sed -n '2,30p' "$0" ;;
esac
