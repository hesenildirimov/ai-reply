-- Native-sounding replies: learned writing style + preset; no AI self-disclosure by default.
ALTER TABLE assistants ADD COLUMN style_preset text NOT NULL DEFAULT 'auto'
  CHECK (style_preset IN ('auto', 'friendly', 'polite', 'short'));
ALTER TABLE assistants ADD COLUMN style_guide text NOT NULL DEFAULT '';
ALTER TABLE assistants ADD COLUMN style_learned_at timestamptz;
ALTER TABLE assistants DROP COLUMN tone;
ALTER TABLE assistants ALTER COLUMN ai_disclosure SET DEFAULT false;
UPDATE assistants SET ai_disclosure = false;
-- Holding message must not mention operators or AI.
ALTER TABLE assistants ALTER COLUMN handoff_message SET DEFAULT 'Bir dəqiqə, dəqiqləşdirib yazıram 🙏';
UPDATE assistants SET handoff_message = 'Bir dəqiqə, dəqiqləşdirib yazıram 🙏'
  WHERE handoff_message ILIKE '%əməkdaş%' OR handoff_message ILIKE '%operator%' OR handoff_message ILIKE '%menecer%';

-- Where to alert the business when a customer is waiting for a human.
CREATE TABLE notify_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('telegram')),
  chat_id text NOT NULL,
  label text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, chat_id)
);
