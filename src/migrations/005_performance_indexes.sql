-- Dashboard responsiveness: indexes for the admin list/overview queries.
CREATE INDEX IF NOT EXISTS idx_messages_guest_dir_type_created
  ON messages (guest_id, direction, message_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_out_created
  ON messages (direction, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_in_created
  ON messages (direction, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_trigger_reason
  ON messages (trigger_reason);
CREATE INDEX IF NOT EXISTS idx_journey_events_guest
  ON journey_events (guest_id, id);
CREATE INDEX IF NOT EXISTS idx_activities_date
  ON activities (date);
