-- Rollback for 009 (then DELETE FROM schema_migrations WHERE name = '009_knowledge_ai.sql').
DROP INDEX IF EXISTS messages_ws_created;
ALTER TABLE ai_usage DROP COLUMN IF EXISTS route;
ALTER TABLE conversations DROP COLUMN IF EXISTS summary_upto, DROP COLUMN IF EXISTS summary;
DROP TABLE IF EXISTS knowledge_history, knowledge_items;
