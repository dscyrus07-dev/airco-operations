// Google Sheets integration: OAuth (offline refresh token) + polling sync.
// Feeds fetched rows into the EXISTING bulk-import pipeline — no second
// importer. Auth: Google OAuth web-server flow with access_type=offline;
// the refresh token lives in Railway env (preferred) or app_settings.
import { query } from '../db.js';
import { getConfig } from '../config.js';
import crypto from 'node:crypto';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const SHEETS_VALUES = 'https://sheets.googleapis.com/v4/spreadsheets';

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';

// The EXACT redirect URI Google Cloud must have registered.
export function redirectUri(origin) {
  return `${origin.replace(/\/$/, '')}/admin/google/callback`;
}

export function buildAuthUrl({ clientId, redirect, state }) {
  const u = new URL(AUTH_ENDPOINT);
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirect);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SHEETS_SCOPE);
  u.searchParams.set('access_type', 'offline'); // refresh token without user presence
  u.searchParams.set('prompt', 'consent'); // force refresh_token issuance even if previously granted
  u.searchParams.set('state', state);
  return u.toString();
}

// Exchange the one-time authorization code for tokens.
export async function exchangeCode({ clientId, clientSecret, redirect, code }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token exchange failed: ${body.error ?? res.status}`);
    err.googleError = body;
    throw err;
  }
  return body; // { access_token, refresh_token?, expires_in, ... }
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google token refresh failed: ${body.error ?? res.status}`);
    err.googleError = body;
    throw err;
  }
  return body; // { access_token, expires_in, ... }
}

// ---- refresh token storage: Railway env wins; DB app_settings as fallback ----

export async function getRefreshToken() {
  const envToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  if (envToken && envToken.trim()) return envToken.trim();
  const rows = await query(`SELECT value FROM app_settings WHERE key = 'google_oauth_refresh_token'`);
  return rows[0]?.value ?? null;
}

export async function storeRefreshToken(token) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('google_oauth_refresh_token', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [token]
  );
}

// ---- OAuth state (single-use, protects the public callback) ----

export async function issueState() {
  const state = crypto.randomBytes(24).toString('hex');
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('google_oauth_state', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [state]
  );
  return state;
}

export async function consumeState(state) {
  const rows = await query(`SELECT value FROM app_settings WHERE key = 'google_oauth_state'`);
  const stored = rows[0]?.value;
  await query(`DELETE FROM app_settings WHERE key = 'google_oauth_state'`);
  return Boolean(state && stored && state === stored);
}

// ---- access token cache ----

let cachedAccess = { token: null, expiresAt: 0 };

export async function getAccessToken() {
  if (cachedAccess.token && Date.now() < cachedAccess.expiresAt - 60_000) return cachedAccess.token;
  const cfg = getConfig();
  const refreshToken = await getRefreshToken();
  if (!refreshToken) throw new Error('Google Sheets not connected — no refresh token');
  const res = await refreshAccessToken({
    clientId: cfg.googleOAuthClientId,
    clientSecret: cfg.googleOAuthClientSecret,
    refreshToken,
  });
  cachedAccess = {
    token: res.access_token,
    expiresAt: Date.now() + (res.expires_in ?? 3600) * 1000,
  };
  return cachedAccess.token;
}

// ---- sheet fetch + conversion to the parser's tab-separated format ----

// Sheets values API returns rows of cells — convert to TSV text exactly like
// a pasted report so parseBulkReport() consumes it unchanged.
export function rowsToTsv(rows) {
  return (rows ?? [])
    .map((cells) => cells.map((c) => String(c ?? '').replace(/[\t\r\n]+/g, ' ').trim()).join('\t'))
    .filter((line) => line.trim().length > 0)
    .join('\n');
}

export async function fetchSheetRows() {
  const cfg = getConfig();
  const token = await getAccessToken();
  const range = encodeURIComponent(`${cfg.googleSheetTab}!${cfg.googleSheetRange}`);
  const res = await fetch(`${SHEETS_VALUES}/${cfg.googleSheetId}/values/${range}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Google Sheets fetch failed: ${body.error?.message ?? res.status}`);
    err.googleError = body.error;
    throw err;
  }
  return body.values ?? [];
}

// ---- the sync itself: fetch → EXISTING parser → EXISTING importer ----

export async function syncNow() {
  const cfg = getConfig();
  if (!cfg.googleSheetsEnabled) return { skipped: true, reason: 'google sheets disabled' };
  const rows = await fetchSheetRows();
  if (!rows.length) {
    await recordSync({ ok: true, rows: 0, note: 'sheet empty' });
    return { ok: true, imported: null, rows: 0 };
  }
  const text = rowsToTsv(rows);
  const { importBulkReport } = await import('../agent/bulk-import.js');
  const result = await importBulkReport(text, { uploadedBy: 'google_sheets', execute: true });
  await recordSync({ ok: true, rows: rows.length, summary: result.summary });
  return { ok: true, rows: rows.length, ...result };
}

async function recordSync({ ok, rows, summary, note, error }) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('google_last_sync', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = now()`,
    [JSON.stringify({ at: new Date().toISOString(), ok, rows, summary: summary ?? null, note: note ?? null, error: error ?? null })]
  );
}

export async function getLastSync() {
  const rows = await query(`SELECT value, updated_at FROM app_settings WHERE key = 'google_last_sync'`);
  if (!rows[0]?.value) return null;
  try { return JSON.parse(rows[0].value); } catch { return null; }
}

export async function isConnected() {
  return Boolean(await getRefreshToken());
}
