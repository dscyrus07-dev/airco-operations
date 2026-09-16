const PROPERTY_NAME = 'Zostel Mumbai';
const PROPERTY_ADDRESS =
  'Zostel Mumbai, Karotra Niwas School, off Military Road, near Prime Academy, Bhavani Nagar, Marol, Andheri East, Mumbai, Maharashtra 400059';
const REVIEW_URL = process.env.REVIEW_URL || 'REVIEW_URL_PENDING';

// These bodies must match the approved templates in Meta Business Manager exactly
// (same name, language 'en', same variable positions).
export const TEMPLATES = [
  {
    name: 'booking_confirmation',
    category: 'utility',
    body:
      'Hi {{1}}! Your stay at {{2}} is confirmed from {{3}} to {{4}}. Reply here any time if you need anything before you arrive.',
  },
  {
    name: 'checkin_info',
    category: 'utility',
    body:
      'Hi {{1}}, your check-in at {{2}} is tomorrow. Check-in from 2 PM — carry a valid photo ID. Address: {{3}}. Reply here for directions or help.',
  },
  {
    name: 'checkout_reminder',
    category: 'utility',
    body:
      'Hi {{1}}, a quick reminder: your check-out from {{2}} is tomorrow by 11 AM. Please clear any pending dues at the front desk. Thank you!',
  },
  {
    name: 'review_request',
    category: 'utility',
    body:
      'Hi {{1}}, thank you for staying at {{2}}! We would love your feedback — it helps us improve: {{3}}',
  },
];

function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(`${d}T12:00:00Z`);
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

export function templateVariables(name, guest) {
  switch (name) {
    case 'booking_confirmation':
      return [guest.name, guest.property || PROPERTY_NAME, fmtDate(guest.check_in), fmtDate(guest.check_out)];
    case 'checkin_info':
      return [guest.name, guest.property || PROPERTY_NAME, PROPERTY_ADDRESS];
    case 'checkout_reminder':
      return [guest.name, guest.property || PROPERTY_NAME];
    case 'review_request':
      return [guest.name, guest.property || PROPERTY_NAME, REVIEW_URL];
    default:
      throw new Error(`unknown template: ${name}`);
  }
}

export function templateComponents(vars) {
  return [
    {
      type: 'body',
      parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })),
    },
  ];
}

// TEST-ONLY: Meta test WhatsApp Business Accounts auto-reject custom template
// submissions, so on a test WABA sends can be remapped to Meta's pre-approved
// sample templates via TEMPLATE_OVERRIDES. Never set this in production.
// Example: TEMPLATE_OVERRIDES={"booking_confirmation":{"name":"jaspers_market_order_confirmation_v1","language":"en_US","vars":["guest_name","guest_id","check_in"]}}
export function templateOverride(name, ctx) {
  const raw = process.env.TEMPLATE_OVERRIDES;
  if (!raw) return null;
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    console.warn('[templates] TEMPLATE_OVERRIDES set but not valid JSON — ignoring');
    return null;
  }
  const o = map?.[name];
  if (!o?.name) return null;
  const vars = (o.vars ?? []).map((k) => String(ctx[k] ?? ''));
  console.warn(
    `[templates] TEST OVERRIDE: sending ${name} as ${o.name}/${o.language ?? 'en'} (vars: ${(o.vars ?? []).join(',')})`
  );
  return { name: o.name, language: o.language ?? 'en', components: templateComponents(vars) };
}
