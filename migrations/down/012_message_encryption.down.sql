-- Rollback for 012 (then DELETE FROM schema_migrations WHERE name = '012_message_encryption.sql').
-- Decrypt first if rows were sealed: once enc is dropped the ciphertext can no longer be told apart.
DROP INDEX IF EXISTS conversations_last_inbound;
ALTER TABLE conversation_notes DROP CONSTRAINT IF EXISTS conversation_notes_body_check;
ALTER TABLE conversation_notes ADD CONSTRAINT conversation_notes_body_check CHECK (length(body) BETWEEN 1 AND 2000) NOT VALID;
DROP INDEX IF EXISTS messages_plain;
DROP INDEX IF EXISTS messages_search;
ALTER TABLE messages DROP COLUMN IF EXISTS search_tokens;
ALTER TABLE messages DROP COLUMN IF EXISTS enc;
CREATE INDEX IF NOT EXISTS messages_body_trgm ON messages USING gin (body gin_trgm_ops);
