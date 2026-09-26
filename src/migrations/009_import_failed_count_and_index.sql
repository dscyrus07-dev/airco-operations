-- FIX 7: import batches record rows that failed + rolled back.
ALTER TABLE import_batches ADD COLUMN IF NOT EXISTS failed_count INT NOT NULL DEFAULT 0;

-- FIX 11 (M6): the already-sent dedupe checks all query
--   WHERE guest_id = $1 AND template_name = $2 AND status IN (...)
-- so the index leads with guest_id (equality), then template_name, then the
-- status filter — NOT (template_name, status) as first suggested.
CREATE INDEX IF NOT EXISTS idx_messages_guest_template_status
  ON messages (guest_id, template_name, status);
