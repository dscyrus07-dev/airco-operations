CREATE TABLE IF NOT EXISTS guests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  property      TEXT NOT NULL DEFAULT 'Zostel Mumbai',
  room          TEXT,
  check_in      DATE,
  check_out     DATE,
  journey_state TEXT NOT NULL DEFAULT 'booked'
                CHECK (journey_state IN ('booked','pre_arrival','checked_in','in_stay','checkout_pending','checked_out','review_requested','closed')),
  ai_paused     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_id            BIGINT NOT NULL REFERENCES guests(id),
  direction           TEXT NOT NULL CHECK (direction IN ('in','out')),
  content             TEXT,
  message_type        TEXT NOT NULL CHECK (message_type IN ('template','free_text')),
  template_name       TEXT,
  template_components JSONB NOT NULL DEFAULT '[]'::jsonb,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','sent','delivered','read','failed')),
  wa_message_id       TEXT UNIQUE,
  trigger_reason      TEXT NOT NULL,
  retry_count         INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_messages_guest_created ON messages (guest_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages (status) WHERE status = 'queued';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_messages_guest_template
  ON messages (guest_id, template_name) WHERE template_name IS NOT NULL;

CREATE TABLE IF NOT EXISTS templates (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  category        TEXT NOT NULL CHECK (category IN ('utility','marketing','authentication')),
  approval_status TEXT NOT NULL DEFAULT 'PENDING',
  body            TEXT NOT NULL,
  language        TEXT NOT NULL DEFAULT 'en',
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS requests (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_id      BIGINT NOT NULL REFERENCES guests(id),
  request_type  TEXT NOT NULL,
  description   TEXT,
  assigned_to   TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','completed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS activities (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  property    TEXT NOT NULL,
  date        DATE NOT NULL,
  time        TEXT NOT NULL,
  event_name  TEXT NOT NULL,
  description TEXT,
  audience    TEXT NOT NULL DEFAULT 'All Guests',
  status      TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS journey_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guest_id    BIGINT NOT NULL REFERENCES guests(id),
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  event       TEXT NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_journey_events_guest ON journey_events (guest_id, created_at);
