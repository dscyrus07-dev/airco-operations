// Database-backed journey template configuration.
// The dashboard can edit template copy + the review link without code deploys;
// the send path reads from here (60s cache), falling back to the built-in
// definitions when a template has no DB row.
import { query } from '../db.js';
import { TEMPLATES, templateVariables } from './definitions.js';

const CACHE_TTL_MS = 60_000;
let cache = { at: 0, map: null };

export const TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

function invalidate() {
  cache = { at: 0, map: null };
}

async function loadAll() {
  if (cache.map && Date.now() - cache.at < CACHE_TTL_MS) return cache.map;
  const rows = await query('SELECT name, body, content_sid FROM template_settings');
  const map = {};
  for (const r of rows) map[r.name] = { body: r.body, contentSid: r.content_sid };
  cache = { at: Date.now(), map };
  return map;
}

// Effective config for one template: DB row wins, definitions fallback.
export async function getTemplateConfig(name) {
  const map = await loadAll();
  const row = map[name];
  if (row) return row;
  const def = TEMPLATES.find((t) => t.name === name);
  return def ? { body: def.body, contentSid: null } : null;
}

export async function getAllTemplateConfigs() {
  const map = await loadAll();
  return TEMPLATES.map((t) => ({
    name: t.name,
    category: t.category,
    body: map[t.name]?.body ?? t.body,
    contentSid: map[t.name]?.contentSid ?? null,
    variables: (t.body.match(/\{\{\d+\}\}/g) ?? []).length,
  }));
}

export async function setTemplateBody(name, body) {
  await query(
    `INSERT INTO template_settings (name, body, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE SET body = $2, updated_at = now()`,
    [name, body]
  );
  invalidate();
}

export async function setTemplateContentSid(name, contentSid) {
  await query(
    `INSERT INTO template_settings (name, body, content_sid, updated_at)
     VALUES ($1, COALESCE((SELECT body FROM template_settings WHERE name = $1), ''), $2, now())
     ON CONFLICT (name) DO UPDATE SET content_sid = $2, updated_at = now()`,
    [name, contentSid]
  );
  invalidate();
}

// ---- review link (app_settings) ----

export async function getReviewUrl() {
  const rows = await query(`SELECT value FROM app_settings WHERE key = 'review_url'`);
  const fromDb = rows[0]?.value ?? '';
  return fromDb || process.env.REVIEW_URL || '';
}

export async function setReviewUrl(url) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('review_url', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [url ?? '']
  );
}

// Build the variable values for a template at send time — same positions as
// the built-in definitions, but the review link now comes from app_settings.
export async function buildTemplateVars(name, guest) {
  if (name === 'review_request') {
    const reviewUrl = (await getReviewUrl()) || 'REVIEW_URL_PENDING';
    return [guest.name, reviewUrl];
  }
  return templateVariables(name, guest);
}
