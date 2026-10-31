-- Requests from the public website ("Görüş təyin et" / "Bu paketlə başla"): the platform admin's sales list.
CREATE TABLE leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  business text NOT NULL CHECK (length(business) BETWEEN 1 AND 120),
  phone text NOT NULL CHECK (length(phone) BETWEEN 5 AND 40),
  email text NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  instagram text NOT NULL DEFAULT '' CHECK (length(instagram) <= 120),
  industry text NOT NULL DEFAULT '' CHECK (length(industry) <= 40),
  monthly_messages text NOT NULL DEFAULT '' CHECK (length(monthly_messages) <= 40),
  plan text NOT NULL DEFAULT 'unknown' CHECK (plan IN ('start', 'biznes', 'pro', 'unknown')),
  intent text NOT NULL DEFAULT 'demo' CHECK (intent IN ('demo', 'call')),
  preferred_time text NOT NULL DEFAULT '' CHECK (length(preferred_time) <= 120),
  message text NOT NULL DEFAULT '' CHECK (length(message) <= 2000),
  lang text NOT NULL DEFAULT 'az' CHECK (lang IN ('az', 'ru', 'en')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'meeting', 'won', 'lost')),
  consent_at timestamptz NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leads_status_created ON leads (status, created_at DESC);

CREATE TABLE lead_notes (
  id bigserial PRIMARY KEY,
  lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON lead_notes (lead_id, created_at);
