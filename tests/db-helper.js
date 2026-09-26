// Test-database helper for DB-backed tests.
// Uses the local docker-compose postgres (airco_test database). When the DB
// is unreachable, tests using this helper SKIP instead of failing, so the
// suite stays green on machines without docker.
import pg from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgres://postgres:postgres@127.0.0.1:5432/airco_test';

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'migrations'
);

export async function withDb(fn) {
  const pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 5 });
  try {
    await pool.query('SELECT 1');
  } catch (err) {
    await pool.end().catch(() => {});
    return { skipped: true, reason: `test DB unavailable (${err.code ?? err.message})` };
  }
  try {
    // apply migrations in filename order (idempotent IF NOT EXISTS)
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    for (const f of files) {
      await pool.query(readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));
    }
    const result = await fn(pool);
    return { skipped: false, result };
  } finally {
    await pool.end().catch(() => {});
  }
}

export async function cleanTables(pool) {
  await pool.query(
    `TRUNCATE messages, journey_events, bookings, import_batches, requests,
       activities, template_settings, app_settings, guests RESTART IDENTITY CASCADE`
  );
}

// Insert a guest directly, bypassing the importer.
export async function insertGuest(pool, { phone, name, state = 'booked', checkIn = null, checkOut = null, room = null }) {
  const { rows } = await pool.query(
    `INSERT INTO guests (phone, name, journey_state, check_in, check_out, room, whatsapp_opt_in)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`,
    [phone, name, state, checkIn, checkOut, room]
  );
  return rows[0];
}

// Insert a booking row directly.
export async function insertBooking(pool, { guestId, resNo, arrival, departure, room = '101' }) {
  const { rows } = await pool.query(
    `INSERT INTO bookings (reservation_number, guest_id, guest_name, contact_number,
       room_number, arrival, departure, classification, reservation_type)
     VALUES ($1, $2, 'Test Guest', '910000000000', $3, $4, $5, 'BOOKING', 'CONFIRM_BOOKING')
     RETURNING *`,
    [resNo, guestId, room, arrival, departure]
  );
  return rows[0];
}
