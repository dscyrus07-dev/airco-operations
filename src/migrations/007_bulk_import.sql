-- Bulk import: Zostel operational report support.
-- import_batches tracks each paste; bookings stores every reservation row
-- (guest identity stays in guests — a guest may hold multiple reservations).
CREATE TABLE IF NOT EXISTS import_batches (
  id SERIAL PRIMARY KEY,
  uploaded_by TEXT,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  row_count INT NOT NULL DEFAULT 0,
  booking_count INT NOT NULL DEFAULT 0,
  non_booking_count INT NOT NULL DEFAULT 0,
  invalid_count INT NOT NULL DEFAULT 0,
  duplicate_count INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bookings (
  id SERIAL PRIMARY KEY,
  reservation_number TEXT,
  guest_id INTEGER REFERENCES guests(id),
  emp_name TEXT,
  contact_number TEXT,
  guest_name TEXT,
  room_number TEXT,
  rate NUMERIC,
  arrival TIMESTAMPTZ,
  departure TIMESTAMPTZ,
  nights INT,
  pax TEXT,
  reservation_type TEXT,
  deposit NUMERIC,
  balance_due NUMERIC,
  business_source TEXT,
  cash NUMERIC,
  card NUMERIC,
  upi NUMERIC,
  nos TEXT,
  raw_row JSONB,
  batch_id INTEGER REFERENCES import_batches(id),
  classification TEXT NOT NULL DEFAULT 'BOOKING', -- BOOKING | NON_BOOKING | INVALID
  pre_arrival_due_at TIMESTAMPTZ,
  pre_arrival_sent_at TIMESTAMPTZ,
  pre_arrival_status TEXT,
  checkout_reminder_due_at TIMESTAMPTZ,
  checkout_reminder_sent_at TIMESTAMPTZ,
  checkout_reminder_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reservation identity: one row per reservation number (suffixes -1/-2 are
-- distinct reservations). Blank reservation numbers (non-booking rows) are
-- not unique-constrained.
CREATE UNIQUE INDEX idx_bookings_res_unique
  ON bookings (reservation_number)
  WHERE reservation_number IS NOT NULL AND reservation_number <> '';
CREATE INDEX idx_bookings_guest ON bookings (guest_id);
CREATE INDEX idx_bookings_batch ON bookings (batch_id);
CREATE INDEX idx_bookings_pre_arrival_due ON bookings (pre_arrival_due_at)
  WHERE pre_arrival_sent_at IS NULL;
CREATE INDEX idx_bookings_checkout_due ON bookings (checkout_reminder_due_at)
  WHERE checkout_reminder_sent_at IS NULL;


-- Manual sends (explicit staff action) must bypass the one-per-stay journey
-- dedupe: drop the blanket unique index and enforce idempotency per journey
-- event in the scheduler instead (already checks sent/queued per template).
DROP INDEX IF EXISTS uniq_messages_guest_template;
