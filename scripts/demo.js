import 'dotenv/config';
process.env.WHATSAPP_DRY_RUN = 'true';
import assert from 'node:assert/strict';
import { handleBookingWebhook, applyEventToGuest, runDateTick } from '../src/agent/triggers.js';
import { query, closePool } from '../src/db.js';

const DAY_MS = 86_400_000;
const phone = process.argv[2] || `9199${Date.now().toString().slice(-8)}`;
const day = (offset) => new Date(Date.now() + offset * DAY_MS).toISOString().slice(0, 10);

console.log(`demo guest phone: ${phone} (check-in ${day(1)}, check-out ${day(3)})`);

const guest = await handleBookingWebhook({
  phone,
  name: 'Test Guest',
  room: '304',
  check_in: day(1),
  check_out: day(3),
});
await applyEventToGuest(guest, 'booking_created', 'demo booking webhook', new Date());

await runDateTick(new Date());

let g = (await query('SELECT * FROM guests WHERE id = $1', [guest.id]))[0];
await applyEventToGuest(g, 'checked_in', 'demo check-in', new Date());

const day2 = new Date(Date.now() + 2 * DAY_MS);
await runDateTick(day2);

g = (await query('SELECT * FROM guests WHERE id = $1', [guest.id]))[0];
await applyEventToGuest(g, 'checked_out', 'demo checkout', day2);

const messages = await query(
  `SELECT template_name, status, trigger_reason FROM messages
   WHERE guest_id = $1 AND direction = 'out' ORDER BY id`,
  [guest.id]
);
console.table(messages);

const expected = ['booking_confirmation', 'checkin_info', 'checkout_reminder', 'review_request'];
assert.deepEqual(
  messages.map((m) => m.template_name),
  expected,
  'expected exactly the 4 Phase 1 messages, in order'
);
assert.ok(messages.every((m) => m.status === 'sent'), 'all messages should be sent (dry-run)');

const events = await query(
  `SELECT from_state, to_state, event FROM journey_events WHERE guest_id = $1 ORDER BY id`,
  [guest.id]
);
console.table(events);

const finalGuest = (await query('SELECT journey_state FROM guests WHERE id = $1', [guest.id]))[0];
assert.equal(finalGuest.journey_state, 'review_requested');

console.log('DEMO OK: 4 messages in order, journey ended at review_requested');
await closePool();
