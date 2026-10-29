# Backup service: pg_dump plus age, so dumps are encrypted before they touch the disk, and rclone for the off-host
# copy (scripts/backup.sh).
FROM postgres:16@sha256:1beaa3084eee2676f20a9cd9928f0bf2c5bf674f8e49f81017912183d377c61c
RUN apt-get update && apt-get install -y --no-install-recommends age rclone ca-certificates && rm -rf /var/lib/apt/lists/*
