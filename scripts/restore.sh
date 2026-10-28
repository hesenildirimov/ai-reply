#!/bin/sh
# Usage (on the server):
#   ./scripts/restore.sh backups/aireply-YYYYMMDD-HHMM.dump.age /path/to/age-key.txt   (encrypted backup)
#   ./scripts/restore.sh backups/aireply-YYYYMMDD-HHMM.dump                            (old, unencrypted backup)
# Needs `age` on the server for encrypted backups (apt-get install age). Bring the private key only for the restore
# and delete it from the server afterwards. Restores into the running `db` service; web/worker are stopped meanwhile.
# The original ENCRYPTION_KEY is required too, otherwise stored tokens and messages cannot be decrypted
# (the app refuses to start with a different key).
set -eu
[ -f "${1:-}" ] || { echo "usage: $0 <dump file> [age key file]"; exit 1; }
case "$1" in
  *.age) [ -f "${2:-}" ] || { echo "encrypted backup: pass the age private key file as the second argument"; exit 1; } ;;
esac
docker compose stop web worker
case "$1" in
  *.age) age -d -i "$2" "$1" | docker compose exec -T db pg_restore -U aireply_owner -d aireply --clean --if-exists --no-owner ;;
  *) docker compose exec -T db pg_restore -U aireply_owner -d aireply --clean --if-exists --no-owner < "$1" ;;
esac
docker compose start web worker
echo "restored $1"
