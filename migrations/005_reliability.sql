-- P0: delivery idempotency, token lifecycle, AI cost ledger, error events, audit log.

-- Every outbound message is claimed with an idempotency key before it is sent, so retries
-- never send a confirmed (or possibly-sent) message twice.
ALTER TABLE messages ADD COLUMN status text NOT NULL DEFAULT 'sent';
UPDATE messages SET status = 'received' WHERE direction = 'in';
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('received', 'pending', 'sent', 'failed', 'unknown'));
ALTER TABLE messages ADD COLUMN idempotency_key text;
ALTER TABLE messages ADD COLUMN error text;
CREATE UNIQUE INDEX messages_idem_key ON messages (workspace_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Token lifecycle: explicit re-authorization state, granted scopes, refresh bookkeeping.
ALTER TABLE channels DROP CONSTRAINT channels_status_check;
UPDATE channels SET status = 'reauth_required' WHERE status = 'error';
ALTER TABLE channels ADD CONSTRAINT channels_status_check CHECK (status IN ('active', 'reauth_required'));
ALTER TABLE channels ADD COLUMN status_reason text NOT NULL DEFAULT '';
ALTER TABLE channels ADD COLUMN scopes text[] NOT NULL DEFAULT '{}';
ALTER TABLE channels ADD COLUMN token_refreshed_at timestamptz;

-- AI cost ledger (one row per Claude call). Cost is an estimate from config/ai-models.json.
CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  purpose text NOT NULL CHECK (purpose IN ('reply', 'summary', 'style', 'test')),
  model text NOT NULL,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  cache_read_tokens int NOT NULL DEFAULT 0,
  cache_write_tokens int NOT NULL DEFAULT 0,
  est_cost_usd numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms int NOT NULL DEFAULT 0,
  outcome text NOT NULL CHECK (outcome IN ('reply', 'handoff', 'refusal', 'timeout', 'error')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_usage (workspace_id, created_at);

-- Provider errors / rate limits (for monitoring and analytics; no tokens or message text).
CREATE TABLE channel_events (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES channels(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('api_error', 'rate_limit', 'token_invalid', 'ai_timeout', 'ai_error')),
  code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON channel_events (workspace_id, created_at);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (workspace_id, created_at DESC);
