-- Rollback for 013 (then DELETE FROM schema_migrations WHERE name = '013_media.sql').
DELETE FROM ai_usage WHERE purpose = 'media';
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('reply', 'summary', 'style', 'test'));
ALTER TABLE messages DROP COLUMN IF EXISTS media_text;
