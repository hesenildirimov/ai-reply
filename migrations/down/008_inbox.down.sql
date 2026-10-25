-- Rollback for 008 (then DELETE FROM schema_migrations WHERE name = '008_inbox.sql').
DROP INDEX IF EXISTS messages_body_trgm;
DROP TABLE IF EXISTS saved_replies, conversation_notes;
