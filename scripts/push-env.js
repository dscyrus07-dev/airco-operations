// Pushes every variable from local .env to the linked Railway service.
// Uses execFileSync (no shell) so values with quotes/JSON survive intact.
// Usage: node scripts/push-env.js
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const RAILWAY_CLI = process.env.RAILWAY_CLI || 'railway';

const lines = readFileSync('.env', 'utf8').split(/\r?\n/);
for (const line of lines) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (!m) continue;
  const key = m[1];
  const val = m[2].trim();
  if (!val || key === 'PORT' || key === 'WHATSAPP_DRY_RUN') continue;
  try {
    execFileSync(
      process.execPath,
      [
        'C:\\Users\\admin\\AppData\\Roaming\\npm\\node_modules\\@railway\\cli\\bin\\railway.js',
        'variables',
        '--skip-deploys',
        '--set',
        `${key}=${val}`,
      ],
      { stdio: 'pipe' }
    );
    console.log(`set ${key}`);
  } catch (err) {
    console.error(`FAILED ${key}: ${err.message.slice(0, 120)}`);
  }
}
console.log('done');
