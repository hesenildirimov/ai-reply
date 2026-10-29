#!/bin/sh
# Monthly restore drill (audit L-2): proves a backup actually opens and restores, without touching the live data.
# Usage (on the server, with the age private key brought in only for the drill):
#   ./scripts/restore-test.sh backups/aireply-YYYYMMDD-HHMM.dump.age /path/to/age-key.txt
# Restores into a throwaway database "aireply_restore_test" in the running db service, prints row counts, drops it.
set -eu
[ -f "${1:-}" ] && [ -f "${2:-}" ] || { echo "usage: $0 <dump.age> <age key file>"; exit 1; }
db() { docker compose exec -T db "$@"; }
db dropdb -U aireply_owner --if-exists aireply_restore_test
db createdb -U aireply_owner aireply_restore_test
trap 'db dropdb -U aireply_owner --if-exists aireply_restore_test' EXIT
age -d -i "$2" "$1" | db pg_restore -U aireply_owner -d aireply_restore_test --no-owner --exit-on-error
db psql -U aireply_owner -d aireply_restore_test -At -c \
  "SELECT 'workspaces=' || count(*) FROM workspaces UNION ALL SELECT 'messages=' || count(*) FROM messages UNION ALL SELECT 'migrations=' || count(*) FROM schema_migrations"
echo "restore drill ok: $1 (now delete the key from this server: shred -u $2)"
