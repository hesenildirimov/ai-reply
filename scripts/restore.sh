#!/bin/sh
# Usage (on the server): ./scripts/restore.sh backups/aireply-YYYYMMDD-HHMM.dump
# Restores into the running `db` service. Stop web/worker first. The original ENCRYPTION_KEY is required,
# otherwise stored Instagram/WhatsApp tokens cannot be decrypted (the app refuses to start with a different key).
set -eu
[ -f "${1:-}" ] || { echo "usage: $0 <dump file>"; exit 1; }
docker compose stop web worker
docker compose exec -T db pg_restore -U app -d aireply --clean --if-exists --no-owner < "$1"
docker compose start web worker
echo "restored $1"
