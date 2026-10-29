-- Rollback for 016 (then DELETE FROM schema_migrations WHERE name = '016_admin_controls.sql').
ALTER TABLE workspaces DROP COLUMN IF EXISTS delete_requested_by, DROP COLUMN IF EXISTS delete_requested_at, DROP COLUMN IF EXISTS region;
