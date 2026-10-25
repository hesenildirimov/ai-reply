#!/bin/sh
# Runs once, when the Postgres volume is first created.
# Creates the least-privilege role used by web/worker: data access only (no DDL, no superuser, no COPY PROGRAM).
# Migrations and backups keep using the owner account (POSTGRES_USER).
set -eu
case "$APP_DB_PASSWORD" in *[!A-Za-z0-9]*|'') echo "APP_DB_PASSWORD must be letters/digits only (openssl rand -hex 24)"; exit 1;; esac
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE app_rw LOGIN PASSWORD '$APP_DB_PASSWORD' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE "$POSTGRES_DB" TO app_rw;
GRANT USAGE ON SCHEMA public TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE "$POSTGRES_USER" IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_rw;
SQL
