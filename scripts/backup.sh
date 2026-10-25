#!/bin/sh
# Daily Postgres backup (custom format), kept BACKUP_KEEP_DAYS days. Runs inside the `backup` compose service.
# Copy /backups off the server too (e.g. rclone with encryption to S3/Backblaze): a backup on the same disk is not a backup.
set -eu
umask 077
KEEP="${BACKUP_KEEP_DAYS:-14}"
while true; do
  f="/backups/aireply-$(date -u +%Y%m%d-%H%M).dump"
  if pg_dump -h db -U "${PGUSER:-aireply_owner}" -d aireply -Fc -f "$f.tmp"; then
    mv "$f.tmp" "$f" && echo "backup ok: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.tmp"; echo "BACKUP FAILED" >&2
  fi
  find /backups -name 'aireply-*.dump' -mtime +"$KEEP" -delete
  sleep 86400
done
