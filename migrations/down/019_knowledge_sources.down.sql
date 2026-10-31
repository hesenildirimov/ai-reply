-- Rollback for 019 (then DELETE FROM schema_migrations WHERE name = '019_knowledge_sources.sql').
DELETE FROM knowledge_items WHERE source_id IS NOT NULL;
DROP INDEX IF EXISTS knowledge_items_fts;
DROP INDEX IF EXISTS knowledge_items_source;
ALTER TABLE knowledge_items DROP COLUMN IF EXISTS search, DROP COLUMN IF EXISTS source_id;
DROP TABLE IF EXISTS knowledge_uploads;
DROP TABLE IF EXISTS knowledge_sources;
