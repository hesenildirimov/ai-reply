# Backup service: pg_dump plus age, so dumps are encrypted before they touch the disk (scripts/backup.sh).
FROM postgres:16
RUN apt-get update && apt-get install -y --no-install-recommends age && rm -rf /var/lib/apt/lists/*
