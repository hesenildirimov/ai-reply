CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  password_hash text NOT NULL,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  plan text NOT NULL DEFAULT 'trial',
  monthly_reply_limit int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'agent')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON memberships (user_id);

-- Only SHA-256 hashes of session/auth tokens are stored.
CREATE TABLE sessions (
  id_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE auth_tokens (
  token_hash bytea PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE oauth_states (
  state_hash bytea PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE assistants (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  business_name text NOT NULL DEFAULT '',
  knowledge text NOT NULL DEFAULT '',
  tone text NOT NULL DEFAULT 'Mehriban, qısa və peşəkar',
  handoff_message text NOT NULL DEFAULT 'Sualınızı əməkdaşımıza yönləndirdim, tezliklə sizə cavab veriləcək.',
  ai_disclosure boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('whatsapp', 'instagram')),
  external_id text NOT NULL,          -- WA phone_number_id / IG professional account id
  waba_id text,
  display_name text NOT NULL DEFAULT '',
  access_token_enc text NOT NULL,     -- AES-256-GCM encrypted
  token_expires_at timestamptz,
  extra_enc text,                     -- encrypted JSON (e.g. WA 2FA pin)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'error')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (type, external_id)
);
CREATE INDEX ON channels (workspace_id);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  needs_human boolean NOT NULL DEFAULT false,
  ai_paused_until timestamptz,
  last_inbound_at timestamptz,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_user_id)
);
CREATE INDEX ON conversations (workspace_id, last_message_at DESC);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  sender text NOT NULL CHECK (sender IN ('customer', 'ai', 'human')),
  external_id text,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Webhook retries are deduplicated by the platform message id.
CREATE UNIQUE INDEX ON messages (conversation_id, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX ON messages (conversation_id, created_at);
CREATE INDEX ON messages (created_at);

CREATE TABLE usage_counters (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  period text NOT NULL,               -- YYYY-MM
  ai_replies int NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, period)
);

-- Meta data deletion callback records (kept without personal data).
CREATE TABLE deletion_requests (
  confirmation_code text PRIMARY KEY,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
