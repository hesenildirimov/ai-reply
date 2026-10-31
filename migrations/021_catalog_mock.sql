-- Product catalog, Instagram posts and their products, the integration event log, and the simulated message status.
-- Works in both INTEGRATION_MODE=mock and production; only mock_ig_media is used by the mock Instagram provider alone.

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Short number for Telegram callback_data (64 bytes max: two uuids do not fit). Always resolved together with the workspace.
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku text NOT NULL CHECK (length(sku) BETWEEN 1 AND 60),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 300),
  price numeric(10, 2) NOT NULL CHECK (price >= 0),
  currency text NOT NULL DEFAULT 'AZN' CHECK (currency ~ '^[A-Z]{3}$'),
  image_url text NOT NULL DEFAULT '' CHECK (image_url = '' OR image_url ~ '^https://'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, sku),
  UNIQUE (id, workspace_id)
);

CREATE TABLE ig_posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  caption text NOT NULL DEFAULT '',
  media_type text NOT NULL DEFAULT '',
  permalink text NOT NULL DEFAULT '',
  thumb_url text NOT NULL DEFAULT '',
  posted_at timestamptz,
  detected_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL DEFAULT 'meta' CHECK (source IN ('meta', 'mock')),
  -- pending = waiting for the business to pick products; assigned = products saved; skipped = "no product" chosen
  product_state text NOT NULL DEFAULT 'pending' CHECK (product_state IN ('pending', 'assigned', 'skipped')),
  UNIQUE (channel_id, media_id),
  UNIQUE (id, workspace_id)
);
CREATE INDEX ig_posts_ws_detected ON ig_posts (workspace_id, detected_at DESC);

-- The composite foreign keys make it impossible to link a post of one business to a product of another.
CREATE TABLE post_products (
  post_id uuid NOT NULL,
  product_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  position int NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, product_id),
  FOREIGN KEY (post_id, workspace_id) REFERENCES ig_posts (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (product_id, workspace_id) REFERENCES products (id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX post_products_product ON post_products (product_id);

-- Everything that crosses the Instagram / Telegram boundary, real or simulated (dashboard "Hadisələr").
-- summary and payload hold customer text, so they are stored encrypted like message text.
CREATE TABLE integration_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('instagram', 'telegram')),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 40),
  -- SIMULATED: nothing left this server. DELIVERED: only a real provider confirmed it. RECEIVED: a real inbound event.
  status text NOT NULL CHECK (status IN ('SIMULATED', 'PENDING', 'DELIVERED', 'FAILED', 'RECEIVED')),
  mode text NOT NULL CHECK (mode IN ('mock', 'production')),
  summary text NOT NULL DEFAULT '',
  payload text NOT NULL DEFAULT '',
  external_id text NOT NULL DEFAULT '',
  error text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'production' OR status IN ('SIMULATED', 'FAILED'))
);
CREATE INDEX integration_events_ws ON integration_events (workspace_id, id DESC);
CREATE INDEX integration_events_created ON integration_events (created_at);

-- State of the simulated Instagram account: the posts "published" in mock mode.
CREATE TABLE mock_ig_media (
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id text NOT NULL,
  caption text NOT NULL DEFAULT '',
  media_type text NOT NULL DEFAULT 'IMAGE',
  permalink text NOT NULL DEFAULT '',
  thumb_url text NOT NULL DEFAULT '',
  posted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, media_id)
);

-- A message the mock provider "sent" is stored as simulated: it never reached a customer.
ALTER TABLE messages DROP CONSTRAINT messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check CHECK (status IN ('received', 'pending', 'sent', 'failed', 'unknown', 'simulated'));

-- A comment answered from the product catalog (price question under a post with products), no AI involved.
ALTER TABLE ig_comments DROP CONSTRAINT ig_comments_ai_status_check;
ALTER TABLE ig_comments ADD CONSTRAINT ig_comments_ai_status_check
  CHECK (ai_status IN ('queued', 'skipped', 'handoff', 'pending_approval', 'replied', 'invited', 'rejected', 'failed', 'catalog'));
