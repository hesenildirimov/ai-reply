-- Rollback for 010 (then DELETE FROM schema_migrations WHERE name = '010_saas.sql').
DROP INDEX IF EXISTS audit_log_ws_id;
ALTER TABLE workspaces DROP COLUMN IF EXISTS onboarding_dismissed_at;
DROP TABLE IF EXISTS webhook_deliveries, webhooks;
DROP INDEX IF EXISTS contacts_merged;
ALTER TABLE contacts DROP COLUMN IF EXISTS merged_into;
