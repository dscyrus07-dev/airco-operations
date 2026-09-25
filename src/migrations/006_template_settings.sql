-- Editable journey templates: copy + Twilio ContentSid stored in the database
-- so the dashboard can update them without code deploys. app_settings holds
-- key/value config (review link etc.).
CREATE TABLE IF NOT EXISTS template_settings (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  content_sid TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO template_settings (name, body, content_sid) VALUES
  ('booking_confirmation',
   E'Hey {{1}} 👋\nYour Mumbai adventure is officially booked! 🎒\n📍 Zostel Mumbai, Andheri East\n🛏 {{2}}\n📅 {{3}} → {{4}}\n\nCafe, games, a Bollywood rooftop and a gang of travellers — all waiting for you.\nNeed anything before you arrive? Just drop it here 😎',
   'HX46757941c0eb25362757331afc055129'),
  ('checkin_info',
   E'Hey {{1}}! 👋\nTomorrow''s the day — Mumbai mode: ON ⚡\n\nYou''re checking in at Zostel Mumbai tomorrow from 1:00 PM.\n📍 Andheri East, off Military Road, Marol\n🎒 Carry a valid photo ID.\n\nRooftop views, street food and a hostel full of travellers are waiting.\nGot an arrival question? Drop it right here.',
   'HXc862fce6acee1d990febb945859ddbce'),
  ('welcome',
   E'🚨 YOU HAVE ARRIVED!\nWelcome to Zostel Mumbai, {{1}} 🧡\n\nYour room is sorted. Your Mumbai story starts now.\n🌆 Catch a Marine Drive sunset\n🍜 Hunt down street food\n🎬 Rooftop movie nights\n👋 Meet the gang in the common area\n\nThis chat is your direct line to us — need anything, just say hi.',
   'HXcd2d742fdbf25d3977b688fc4f6f471c'),
  ('checkout_reminder',
   E'Hey {{1}} 👋\nYour Mumbai stay is almost at its final chapter.\n\n🕙 Check-out tomorrow by 10:00 AM.\nDo a quick sweep for chargers, cables and that one sock hiding under the bed 😄\n\nNeed anything before you head out? We''re right here.',
   'HX7628741ebe16e1db2ee2c921a95c4a3e'),
  ('review_request',
   E'🧡 And just like that… your Mumbai chapter comes to an end.\nThanks for being part of the Zostel Mumbai gang, {{1}}.\n\nWe hope you''re leaving with a few new stories, a few new friends, and maybe a little more of Mumbai than you expected. 🌆\n\nGot a minute?\n⭐ Tell us how your stay was:\n{{2}}\n\nSee you on the next adventure 🎒',
   'HXb1845422537d234e66c03017e2e3bc2f')
ON CONFLICT (name) DO NOTHING;

INSERT INTO app_settings (key, value) VALUES ('review_url', '')
ON CONFLICT (key) DO NOTHING;
