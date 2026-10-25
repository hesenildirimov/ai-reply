-- P1: contacts, tags, automations (versioned) with idempotent runs, Instagram comments.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_id text NOT NULL,                 -- IGSID / WhatsApp wa_id
  display_name text NOT NULL DEFAULT '',
  username text NOT NULL DEFAULT '',
  fields jsonb NOT NULL DEFAULT '{}',        -- custom fields (validated keys, string values)
  opted_out boolean NOT NULL DEFAULT false,  -- said STOP: no automated messages
  blocked boolean NOT NULL DEFAULT false,    -- ignored entirely
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_id)
);
CREATE INDEX contacts_ws_seen ON contacts (workspace_id, last_seen_at DESC);
CREATE INDEX contacts_search ON contacts USING gin ((display_name || ' ' || username) gin_trgm_ops);

CREATE TABLE tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color text NOT NULL DEFAULT 'gray'
);
CREATE UNIQUE INDEX tags_ws_name ON tags (workspace_id, lower(name));

CREATE TABLE contact_tags (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

ALTER TABLE conversations ADD COLUMN contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;
INSERT INTO contacts (workspace_id, channel_id, external_id, display_name, first_seen_at, last_seen_at)
  SELECT workspace_id, channel_id, external_user_id, display_name, last_message_at, last_message_at FROM conversations
  ON CONFLICT DO NOTHING;
UPDATE conversations c SET contact_id = ct.id FROM contacts ct WHERE ct.channel_id = c.channel_id AND ct.external_id = c.external_user_id;
CREATE INDEX ON conversations (contact_id);

-- Conversation state for the inbox and bot hand-over (assigned conversations are never answered by the bot).
ALTER TABLE conversations ADD COLUMN status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed'));
ALTER TABLE conversations ADD COLUMN assignee_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE conversations ADD COLUMN unread_count int NOT NULL DEFAULT 0;
CREATE INDEX ON conversations (workspace_id, status, last_message_at DESC);

-- Richer messages: kind, media, quick-reply payload, automation-sent ('bot').
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text', 'media', 'story_reply', 'story_mention', 'quick_reply', 'private_reply'));
ALTER TABLE messages ADD COLUMN media jsonb;
ALTER TABLE messages ADD COLUMN payload text;
ALTER TABLE messages DROP CONSTRAINT messages_sender_check;
ALTER TABLE messages ADD CONSTRAINT messages_sender_check CHECK (sender IN ('customer', 'ai', 'human', 'bot'));

CREATE TABLE automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  trigger text NOT NULL CHECK (trigger IN ('comment', 'dm_keyword', 'story_reply', 'story_mention', 'quick_reply', 'follow')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused')),
  config jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  priority int NOT NULL DEFAULT 100,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON automations (workspace_id, trigger, status);

CREATE TABLE automation_versions (
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version int NOT NULL,
  config jsonb NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (automation_id, version)
);

-- One run per (automation, triggering comment/message): duplicate webhooks can't run a flow twice.
CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version int NOT NULL,
  contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  trigger_ref text NOT NULL,
  status text NOT NULL DEFAULT 'matched' CHECK (status IN ('matched', 'running', 'sent', 'failed', 'skipped')),
  reason text NOT NULL DEFAULT '',
  steps jsonb NOT NULL DEFAULT '[]',
  matched_at timestamptz NOT NULL DEFAULT now(),
  attempted_at timestamptz,
  sent_at timestamptz,
  replied_at timestamptz,
  UNIQUE (automation_id, trigger_ref)
);
CREATE INDEX ON automation_runs (workspace_id, matched_at);
CREATE INDEX ON automation_runs (contact_id, sent_at);

-- Instagram comments we received (dedupe + funnel denominator). Text kept for the retention period only.
CREATE TABLE ig_comments (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id text NOT NULL DEFAULT '',
  from_id text NOT NULL,
  from_username text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  matched boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ig_comments (workspace_id, received_at);

-- Click tracking for links sent by automations (/r/<code> redirects). No IP or user agent is stored.
CREATE TABLE links (
  code text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  automation_id uuid REFERENCES automations(id) ON DELETE SET NULL,
  run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL,
  url text NOT NULL CHECK (url ~ '^https?://'),
  clicks int NOT NULL DEFAULT 0,
  first_click_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON links (automation_id);
