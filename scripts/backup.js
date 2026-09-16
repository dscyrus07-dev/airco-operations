// Nightly database backup to timestamped JSON files, keeping the last 30.
// Run manually (npm run backup) or via Task Scheduler / cron daily.
// Usage: node scripts/backup.js
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backupDir = path.join(__dirname, '..', 'backups');
const KEEP = 30; // keep the last 30 backups (~1 month of daily runs)

const TABLES = ['guests', 'messages', 'templates', 'requests', 'activities', 'journey_events'];

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ...(process.env.DATABASE_URL?.includes('supabase') ? { ssl: { rejectUnauthorized: false } } : {}),
});

async function main() {
  await client.connect();
  const dump = { taken_at: new Date().toISOString(), tables: {} };
  for (const name of TABLES) {
    const r = await client.query(`SELECT * FROM ${name} ORDER BY 1`);
    dump.tables[name] = r.rows;
    console.log(`  ${name}: ${r.rows.length} rows`);
  }
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir, `airco-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(dump, null, 2));
  console.log(`backup written: ${file}`);

  const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('airco-backup-') && f.endsWith('.json')).sort();
  while (files.length > KEEP) {
    const oldest = files.shift();
    try { fs.unlinkSync(path.join(backupDir, oldest)); } catch {}
  }
  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
