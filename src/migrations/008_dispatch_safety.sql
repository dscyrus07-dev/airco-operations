-- FIX 3 (H2) + FIX 4 (H3): dispatch claim + scheduled retries.
-- 'sending' is a transient claimed state; claimed_at marks ownership so a
-- crashed dispatch never double-sends, and next_attempt_at schedules retries
-- instead of blocking the dispatch loop inline.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_status_check;
ALTER TABLE messages ADD CONSTRAINT messages_status_check
  CHECK (status IN ('queued','sending','sent','delivered','read','failed'));

ALTER TABLE messages ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_messages_dispatch
  ON messages (next_attempt_at) WHERE status = 'queued';
