-- Rollback for 021 (then DELETE FROM schema_migrations WHERE name = '021_catalog_mock.sql').
UPDATE ig_comments SET ai_status = 'replied' WHERE ai_status = 'catalog';
ALTER TABLE ig_comments DROP CONSTRAINT IF EXISTS ig_comments_ai_status_check;
ALTER TABLE ig_comments ADD CONSTRAINT ig_comments_ai_status_check CHECK (ai_status IN ('queued', 'skipped', 'handoff', 'pending_approval', 'replied', 'invited', 'rejected', 'failed'));
DELETE FROM messages WHERE status = 'simulated';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('received', 'pending', 'sent', 'failed', 'unknown'));
DROP TABLE IF EXISTS mock_ig_media;
DROP TABLE IF EXISTS integration_events;
DROP TABLE IF EXISTS post_products;
DROP TABLE IF EXISTS ig_posts;
DROP TABLE IF EXISTS products;
