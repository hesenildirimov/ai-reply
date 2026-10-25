-- Rollback for 005 (run manually, then DELETE FROM schema_migrations WHERE name = '005_reliability.sql').
DROP TABLE IF EXISTS audit_log, channel_events, ai_usage;
ALTER TABLE channels DROP COLUMN IF EXISTS token_refreshed_at, DROP COLUMN IF EXISTS scopes, DROP COLUMN IF EXISTS status_reason;
ALTER TABLE channels DROP CONSTRAINT channels_status_check;
UPDATE channels SET status = 'error' WHERE status = 'reauth_required';
ALTER TABLE channels ADD CONSTRAINT channels_status_check CHECK (status IN ('active', 'error'));
DROP INDEX IF EXISTS messages_idem_key;
ALTER TABLE messages DROP COLUMN IF EXISTS error, DROP COLUMN IF EXISTS idempotency_key, DROP CONSTRAINT IF EXISTS messages_status_check, DROP COLUMN IF EXISTS status;
