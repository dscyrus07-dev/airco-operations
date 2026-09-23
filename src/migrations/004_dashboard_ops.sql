-- Dashboard operations: guest archive (soft delete preserves message +
-- journey history) and activity lifecycle (sent_at audit timestamp).
ALTER TABLE guests ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_guests_archived ON guests (archived);

ALTER TABLE activities ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();
