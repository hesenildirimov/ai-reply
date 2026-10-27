-- Message text encrypted at rest (AES-256-GCM, see src/messages.ts) + blind search index.
ALTER TABLE messages ADD COLUMN enc boolean NOT NULL DEFAULT false;   -- true: body is ciphertext
ALTER TABLE messages ADD COLUMN search_tokens text[] NOT NULL DEFAULT '{}';
CREATE INDEX messages_search ON messages USING gin (search_tokens);
-- A trigram index over ciphertext is useless (and large): search goes through search_tokens.
DROP INDEX IF EXISTS messages_body_trgm;
-- Legacy plaintext rows are sealed in batches by maintenance.
CREATE INDEX messages_plain ON messages (id) WHERE NOT enc;

-- Stranded-reply sweep (src/jobs.ts) looks at recently active conversations only.
CREATE INDEX conversations_last_inbound ON conversations (last_inbound_at);
