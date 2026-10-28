-- Webhook intake fallback: when Redis is unreachable, webhook jobs are parked here and moved into the queue later.
CREATE TABLE inbound_outbox (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL UNIQUE,     -- same id the queue job gets: duplicate Meta deliveries collapse
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
