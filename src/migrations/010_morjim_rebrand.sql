-- Rebrand: Zostel Mumbai -> Zostel Morjim.
-- Updates the guests.property default, existing guest rows, and the editable
-- template copy stored in template_settings (DB rows take precedence over the
-- built-in definitions). content_sid values are untouched — new Morjim
-- templates must be created in Twilio and approved before switching SIDs.

ALTER TABLE guests ALTER COLUMN property SET DEFAULT 'Zostel Morjim';
UPDATE guests SET property = 'Zostel Morjim' WHERE property = 'Zostel Mumbai';

UPDATE template_settings SET updated_at = now(), body =
  E'Hey {{1}} 👋\nYour Goa adventure is officially booked! 🎒\n📍 Zostel Morjim, Morjim Beach\n🛏 {{2}}\n📅 {{3}} → {{4}}\n\nBeach days, a buzzing cafe and a gang of travellers — all waiting for you.\nNeed anything before you arrive? Just drop it here 😎'
WHERE name = 'booking_confirmation';

UPDATE template_settings SET updated_at = now(), body =
  E'Hey {{1}}! 👋\nTomorrow''s the day — Goa mode: ON ⚡\n\nYou''re checking in at Zostel Morjim tomorrow from 1:00 PM.\n📍 Morjim Beach, North Goa\n🎒 Carry a valid photo ID.\n\nBeach sunsets, shack food and a hostel full of travellers are waiting.\nGot an arrival question? Drop it right here.'
WHERE name = 'checkin_info';

UPDATE template_settings SET updated_at = now(), body =
  E'🚨 YOU HAVE ARRIVED!\nWelcome to Zostel Morjim, {{1}} 🧡\n\nYour room is sorted. Your Goa story starts now.\n🌅 Catch a Morjim Beach sunset\n🍤 Beach shack hopping\n🏰 Chapora Fort views\n👋 Meet the gang in the common area\n\nThis chat is your direct line to us — need anything, just say hi.'
WHERE name = 'welcome';

UPDATE template_settings SET updated_at = now(), body =
  E'Hey {{1}} 👋\nYour Goa stay is almost at its final chapter.\n\n🕙 Check-out tomorrow by 10:00 AM.\nDo a quick sweep for chargers, cables and that one sock hiding under the bed 😄\n\nNeed anything before you head out? We''re right here.'
WHERE name = 'checkout_reminder';

UPDATE template_settings SET updated_at = now(), body =
  E'🧡 And just like that… your Goa chapter comes to an end.\nThanks for being part of the Zostel Morjim gang, {{1}}.\n\nWe hope you''re leaving with a few new stories, a few new friends, and maybe a little more of Goa than you expected. 🌅\n\nGot a minute?\n⭐ Tell us how your stay was:\n{{2}}\n\nSee you on the next adventure 🎒'
WHERE name = 'review_request';
