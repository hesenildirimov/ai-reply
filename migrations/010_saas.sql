-- P4: contact merge, outgoing webhooks, onboarding state, audit browsing.

-- A merged contact keeps its channel identity (channel_id, external_id) so new messages still resolve to it,
-- but points to the surviving contact that owns tags, fields, conversations and runs.
ALTER TABLE contacts ADD COLUMN merged_into uuid REFERENCES contacts(id) ON DELETE SET NULL;
CREATE INDEX contacts_merged ON contacts (merged_into) WHERE merged_into IS NOT NULL;

CREATE TABLE webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  url text NOT NULL CHECK (url ~ '^https?://' AND length(url) <= 2000),
  secret_enc text NOT NULL,                       -- HMAC signing secret, encrypted with ENCRYPTION_KEY
  events text[] NOT NULL CHECK (cardinality(events) > 0),
  active boolean NOT NULL DEFAULT true,
  consecutive_failures int NOT NULL DEFAULT 0,
  last_status text NOT NULL DEFAULT '',
  last_delivery_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhooks (workspace_id) WHERE active;

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  response_code int,
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX ON webhook_deliveries (webhook_id, created_at DESC);
CREATE INDEX ON webhook_deliveries (created_at);

ALTER TABLE workspaces ADD COLUMN onboarding_dismissed_at timestamptz;
CREATE INDEX audit_log_ws_id ON audit_log (workspace_id, id DESC);
