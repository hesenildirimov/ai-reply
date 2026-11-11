# Backup service: pg_dump plus age, so dumps are encrypted before they touch the disk, and rclone for the off-host
# copy (scripts/backup.sh).
FROM postgres:16@sha256:f9a7b9ebf6f56201f949db745e47bc423c0f0f8294bafe991cc10bf74b029657
RUN apt-get update && apt-get install -y --no-install-recommends age rclone ca-certificates && rm -rf /var/lib/apt/lists/*
