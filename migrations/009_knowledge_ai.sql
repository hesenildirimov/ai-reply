-- P3: versioned knowledge base for retrieval, conversation summaries, analytics indexes.
CREATE TABLE knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('product', 'price', 'delivery', 'faq', 'policy', 'forbidden', 'handoff', 'info')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 4000),
  keywords text[] NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_items (workspace_id, active);
CREATE INDEX knowledge_search ON knowledge_items USING gin ((title || ' ' || body) gin_trgm_ops);

-- Every saved version is kept (who changed a price and when).
CREATE TABLE knowledge_history (
  item_id uuid NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  version int NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  keywords text[] NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, version)
);

-- Rolling summary of older turns so long conversations don't resend their whole history.
ALTER TABLE conversations ADD COLUMN summary text NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN summary_upto timestamptz;

ALTER TABLE ai_usage ADD COLUMN route text NOT NULL DEFAULT 'smart';

CREATE INDEX messages_ws_created ON messages (workspace_id, created_at);
CREATE INDEX ON automation_runs (automation_id, sent_at);
