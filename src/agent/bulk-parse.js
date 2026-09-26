// Zostel operational-report parser: classification + normalisation.
// Pure functions — no DB access. Used by the bulk importer and its tests.

// ---- normalisation helpers ----

// Indian mobile numbers → 91XXXXXXXXXX (digits only, E.164 without +).
// 10-digit → prefix 91; 12-digit starting 91 → as-is; +91 → strip +.
// Anything else (short/long/other country) is returned digits-only as-is.
export function normalizePhone(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && /^[6-9]/.test(digits)) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return '91' + digits.slice(1);
  return digits; // international numbers pass through untouched
}

export function isValidPhone(normalized) {
  return /^\d{10,15}$/.test(normalized ?? '');
}

// "26-09-2026 13.00" → Date (UTC instant representing IST time)
export function parseReportDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:\s+(\d{1,2})[.:](\d{2}))?/);
  if (!m) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }
  const day = parseInt(m[1], 10), month = parseInt(m[2], 10), year = parseInt(m[3], 10);
  const hh = m[4] ? parseInt(m[4], 10) : 12;
  const mm = m[5] ? parseInt(m[5], 10) : 30;
  if (day < 1 || day > 31 || month < 1 || month > 12) return null;
  return new Date(Date.UTC(year, month - 1, day, hh - 5, mm - 30));
}

export function parseMoney(value) {
  const s = String(value ?? '').trim();
  if (!s) return null; // blank stays blank — not a fake zero
  const n = parseFloat(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function parseIntSafe(value) {
  const s = String(value ?? '').trim();
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export function normalizeReservationType(value) {
  return String(value ?? '').trim().toUpperCase().replace(/\s+/g, '_');
}

// ---- row classification ----
// BOOKING     — enough guest/reservation info to act on
// NON_BOOKING — operational rows (Outside Room, NOS, Day End Handover…)
// INVALID     — booking-like but missing/invalid required fields
export function classifyRow(cells) {
  const resNo = cells[1];
  const contact = cells[2];
  const guestName = cells[3];
  const hasGuest = Boolean(guestName && guestName.trim());
  const hasRes = Boolean(resNo && resNo.trim());
  const phone = normalizePhone(contact);

  if (!hasRes && !hasGuest && !phone) return { type: 'NON_BOOKING' };
  if (!hasRes && !phone) return { type: 'NON_BOOKING' };
  if (!hasGuest) return { type: 'INVALID', error: 'missing guest name' };
  if (!hasRes) return { type: 'INVALID', error: 'missing reservation number' };
  if (!phone) return { type: 'INVALID', error: 'missing contact number' };
  if (!isValidPhone(phone)) return { type: 'INVALID', error: `invalid phone: ${contact}` };

  return { type: 'BOOKING', phone, resType: normalizeReservationType(cells[10]) };
}

export function parseBookingRow(cells) {
  const [empName, resNo, contact, guestName, room, rate, arrival, departure, nights, pax, resType, deposit, balanceDue, source, cash, card, upi, nos] = cells;
  return {
    emp_name: empName || null,
    reservation_number: resNo || null,
    contact_number: normalizePhone(contact),
    guest_name: guestName || null,
    room_number: room || null,
    rate: parseMoney(rate),
    arrival: parseReportDate(arrival),
    departure: parseReportDate(departure),
    nights: parseIntSafe(nights),
    pax: pax || null,
    reservation_type: normalizeReservationType(resType),
    deposit: parseMoney(deposit),
    balance_due: parseMoney(balanceDue),
    business_source: source || null,
    cash: parseMoney(cash),
    card: parseMoney(card),
    upi: parseMoney(upi),
    nos: nos || null,
  };
}

export function parseBulkReport(text) {
  const lines = String(text ?? '').split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length === 0) return { headers: null, rows: [] };

  const delim = lines[0].includes('\t') ? '\t' : ',';
  let headers = null;
  let dataLines = lines;
  if (looksLikeHeader(lines[0].split(delim).map((s) => s.trim()))) {
    headers = lines[0].split(delim).map((s) => s.trim());
    dataLines = lines.slice(1);
  }
  const rows = dataLines.map((line, idx) => {
    const cells = line.split(delim).map((s) => s.trim());
    const cls = classifyRow(cells);
    const parsed = cls.type === 'BOOKING' ? parseBookingRow(cells) : null;
    return {
      line: idx + 1,
      raw: cells,
      classification: cls.type,
      error: cls.error ?? null,
      phone: cls.phone ?? null,
      resType: cls.resType ?? null,
      parsed,
    };
  });
  return { headers, rows };
}

function looksLikeHeader(cells) {
  const joined = cells.join(' ').toLowerCase();
  return /res\.?\s?no|contact number|guest|room no|arrival|departure/.test(joined);
}
