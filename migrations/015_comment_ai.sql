-- AI answers to Instagram comments (src/comments.ts). Off by default: the business switches it on.
ALTER TABLE assistants ADD COLUMN comment_ai boolean NOT NULL DEFAULT false;
-- Staff approve each AI comment answer before it is sent.
ALTER TABLE assistants ADD COLUMN comment_approval boolean NOT NULL DEFAULT false;
-- Posts/reels where the AI must not answer comments (e.g. a giveaway post).
ALTER TABLE assistants ADD COLUMN comment_excluded_media text[] NOT NULL DEFAULT '{}';

-- What the AI did with each comment. Drafts and replies are stored encrypted (v1:...), like message text.
ALTER TABLE ig_comments ADD COLUMN ai_status text CHECK (ai_status IN ('queued', 'skipped', 'handoff', 'pending_approval', 'replied', 'invited', 'rejected', 'failed'));
ALTER TABLE ig_comments ADD COLUMN ai_category text CHECK (ai_category IN ('question', 'complaint', 'other'));
ALTER TABLE ig_comments ADD COLUMN conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE ig_comments ADD COLUMN message_id uuid REFERENCES messages(id) ON DELETE SET NULL;
ALTER TABLE ig_comments ADD COLUMN public_reply text NOT NULL DEFAULT '';
ALTER TABLE ig_comments ADD COLUMN public_invite text NOT NULL DEFAULT '';
ALTER TABLE ig_comments ADD COLUMN dm_draft text NOT NULL DEFAULT '';
ALTER TABLE ig_comments ADD COLUMN public_replied_at timestamptz;
ALTER TABLE ig_comments ADD COLUMN handled_at timestamptz;
CREATE INDEX ig_comments_ws_status ON ig_comments (workspace_id, ai_status, received_at DESC);
-- The reply pipeline looks up "is this message a comment?" for every reply.
CREATE INDEX ig_comments_message ON ig_comments (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX ig_comments_from_media ON ig_comments (channel_id, from_id, media_id, public_replied_at);

-- A comment shown inside the commenter's DM conversation (it does not open Meta's 24 h messaging window).
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'media', 'story_reply', 'story_mention', 'quick_reply', 'private_reply', 'comment'));

ALTER TABLE ai_usage DROP CONSTRAINT ai_usage_purpose_check;
ALTER TABLE ai_usage ADD CONSTRAINT ai_usage_purpose_check CHECK (purpose IN ('reply', 'summary', 'style', 'test', 'media', 'comment'));
