#!/bin/bash
# Daily Postgres backup (custom format), encrypted with age to BACKUP_AGE_RECIPIENT, kept BACKUP_KEEP_DAYS days.
# Runs inside the `backup` compose service. Only the PUBLIC key is on the server: a stolen server or backup disk
# reveals no customer conversations. The private key (age-keygen output) stays offline with the ENCRYPTION_KEY backup.
# Copy /backups off the server too (e.g. rclone to S3/Backblaze): a backup on the same disk is not a backup.
set -euo pipefail
umask 077
KEEP="${BACKUP_KEEP_DAYS:-14}"
case "${BACKUP_AGE_RECIPIENT:-}" in
  age1*) ;;
  *) echo "BACKUP_AGE_RECIPIENT must be an age public key (age1...). Generate one: age-keygen -o age-key.txt" >&2; exit 1 ;;
esac
while true; do
  f="/backups/aireply-$(date -u +%Y%m%d-%H%M).dump.age"
  # pipefail: a failed pg_dump fails the pipeline, so a truncated dump is never kept as a good backup.
  if pg_dump -h db -U "${PGUSER:-aireply_owner}" -d aireply -Fc | age -r "$BACKUP_AGE_RECIPIENT" -o "$f.tmp"; then
    mv "$f.tmp" "$f" && echo "backup ok: $f ($(du -h "$f" | cut -f1))"
  else
    rm -f "$f.tmp"; echo "BACKUP FAILED" >&2
  fi
  find /backups -name 'aireply-*.dump*' -mtime +"$KEEP" -delete
  sleep 86400
done
