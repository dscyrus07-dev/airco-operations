// Drains the outbound queue immediately (normally dispatched on webhook
// events, on boot, and every 15 minutes). Ops helper.
// Usage: node scripts/dispatch-now.js
import 'dotenv/config';
import { dispatchPending } from '../src/messaging/outbound.js';
import { closePool } from '../src/db.js';

try {
  await dispatchPending();
  console.log('dispatch complete');
} finally {
  await closePool();
}
