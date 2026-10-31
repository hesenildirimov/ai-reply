-- Knowledge sources (Chatbase-style "Sources"): files, web pages / whole sites and tables, turned into knowledge items.
CREATE TABLE knowledge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('file', 'url', 'site', 'table')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'ready', 'failed')),
  error text NOT NULL DEFAULT '',
  bytes bigint NOT NULL DEFAULT 0, -- extracted text size: what counts against the plan's knowledge_mb
  items int NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON knowledge_sources (workspace_id, created_at DESC);

-- Uploaded file bytes, only until the worker has extracted the text.
CREATE TABLE knowledge_uploads (
  source_id uuid PRIMARY KEY REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  filename text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Items made from a source go with it; they are found by full-text search (a large source does not fit the prompt).
ALTER TABLE knowledge_items ADD COLUMN source_id uuid REFERENCES knowledge_sources(id) ON DELETE CASCADE;
ALTER TABLE knowledge_items ADD COLUMN search tsvector;
CREATE INDEX knowledge_items_source ON knowledge_items (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX knowledge_items_fts ON knowledge_items USING gin (search) WHERE source_id IS NOT NULL;
