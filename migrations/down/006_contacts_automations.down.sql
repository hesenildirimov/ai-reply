-- Rollback for 006 (then DELETE FROM schema_migrations WHERE name = '006_contacts_automations.sql').
DROP TABLE IF EXISTS links, ig_comments, automation_runs, automation_versions, automations, contact_tags, tags;
ALTER TABLE messages DROP CONSTRAINT messages_sender_check;
DELETE FROM messages WHERE sender = 'bot';
ALTER TABLE messages ADD CONSTRAINT messages_sender_check CHECK (sender IN ('customer', 'ai', 'human'));
ALTER TABLE messages DROP COLUMN IF EXISTS payload, DROP COLUMN IF EXISTS media, DROP COLUMN IF EXISTS kind;
ALTER TABLE conversations DROP COLUMN IF EXISTS contact_id, DROP COLUMN IF EXISTS status, DROP COLUMN IF EXISTS assignee_user_id, DROP COLUMN IF EXISTS unread_count;
DROP TABLE IF EXISTS contacts;
