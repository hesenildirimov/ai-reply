-- Rollback for 015 (then DELETE FROM schema_migrations WHERE name = '015_comment_ai.sql').
DELETE FROM ai_usage WHERE purpose = 'comment';
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('reply', 'summary', 'style', 'test', 'media'));
DELETE FROM messages WHERE kind = 'comment';
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'media', 'story_reply', 'story_mention', 'quick_reply', 'private_reply'));
DROP INDEX IF EXISTS ig_comments_ws_status;
DROP INDEX IF EXISTS ig_comments_message;
DROP INDEX IF EXISTS ig_comments_from_media;
ALTER TABLE ig_comments DROP COLUMN IF EXISTS ai_status, DROP COLUMN IF EXISTS ai_category, DROP COLUMN IF EXISTS conversation_id,
  DROP COLUMN IF EXISTS message_id, DROP COLUMN IF EXISTS public_reply, DROP COLUMN IF EXISTS public_invite, DROP COLUMN IF EXISTS dm_draft,
  DROP COLUMN IF EXISTS public_replied_at, DROP COLUMN IF EXISTS handled_at;
ALTER TABLE assistants DROP COLUMN IF EXISTS comment_ai, DROP COLUMN IF EXISTS comment_approval, DROP COLUMN IF EXISTS comment_excluded_media;
