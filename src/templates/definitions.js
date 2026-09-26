const REVIEW_URL = process.env.REVIEW_URL || 'REVIEW_URL_PENDING';

function fmtDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(`${d}T12:00:00Z`);
  return date.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Asia/Kolkata',
  });
}

// These bodies must match the approved templates in Meta Business Manager exactly
// (same name, language 'en', same variable positions). They double as the
// free-text content sent inside the 24h session window (rendered via
// renderTemplateBody), so there is ONE source of copy per message.
export const TEMPLATES = [
  {
    name: 'booking_confirmation',
    category: 'utility',
    body:
      'Hey {{1}} 👋\n' +
      'Your Mumbai adventure is officially booked! 🎒\n' +
      '📍 Zostel Mumbai, Andheri East\n' +
      '🛏 {{2}}\n' +
      '📅 {{3}} → {{4}}\n\n' +
      'Cafe, games, a Bollywood rooftop and a gang of travellers — all waiting for you.\n' +
      'Need anything before you arrive? Just drop it here 😎',
  },
  {
    name: 'checkin_info',
    category: 'utility',
    body:
      'Hey {{1}}! 👋\n' +
      'Mumbai mode: ON ⚡\n\n' +
      'You\'re checking in at Zostel Mumbai on {{2}} from 1:00 PM.\n' +
      '📍 Andheri East, off Military Road, Marol\n' +
      '🎒 Carry a valid photo ID.\n\n' +
      'Rooftop views, street food and a hostel full of travellers are waiting.\n' +
      'Got an arrival question? Drop it right here.',
  },
  {
    name: 'welcome',
    category: 'utility',
    body:
      '🚨 YOU HAVE ARRIVED!\n' +
      'Welcome to Zostel Mumbai, {{1}} 🧡\n\n' +
      'Your room is sorted. Your Mumbai story starts now.\n' +
      '🌆 Catch a Marine Drive sunset\n' +
      '🍜 Hunt down street food\n' +
      '🎬 Rooftop movie nights\n' +
      '👋 Meet the gang in the common area\n\n' +
      'This chat is your direct line to us — need anything, just say hi.',
  },
  {
    name: 'checkout_reminder',
    category: 'utility',
    body:
      'Hey {{1}} 👋\n' +
      'Your Mumbai stay is wrapping up — check-out is by 10:00 AM today.\n' +
      'Do a quick sweep for chargers, cables and that one sock hiding under the bed 😄\n\n' +
      'Running late or need anything? Just reply here — we\'ve got you 😎',
  },
  {
    name: 'review_request',
    category: 'utility',
    body:
      '🧡 And just like that… your Mumbai chapter comes to an end.\n' +
      'Thanks for being part of the Zostel Mumbai gang, {{1}}.\n\n' +
      'We hope you\'re leaving with a few new stories, a few new friends, and maybe a little more of Mumbai than you expected. 🌆\n\n' +
      'Got a minute?\n' +
      '⭐ Tell us how your stay was:\n' +
      '{{2}}\n\n' +
      'See you on the next adventure 🎒',
  },
];

export function templateVariables(name, guest) {
  switch (name) {
    case 'booking_confirmation':
      return [
        guest.name,
        guest.room ? `Room ${guest.room}` : 'Your bunk is sorted',
        fmtDate(guest.check_in),
        fmtDate(guest.check_out),
      ];
    case 'checkin_info':
      // {{2}} = actual arrival date — keeps the copy timing-neutral for both
      // the +1h-after-import trigger and the legacy day-before tick (FIX 8).
      return [guest.name, fmtDate(guest.check_in)];
    case 'welcome':
      return [guest.name];
    case 'checkout_reminder':
      return [guest.name];
    case 'review_request':
      return [guest.name, REVIEW_URL];
    default:
      throw new Error(`unknown template: ${name}`);
  }
}

// Renders {{1}}..{{n}} placeholders with actual values — used for the
// free-text path (24h session window open) so guests get the real copy
// instead of a Meta sample template.
export function renderTemplateBody(name, vars) {
  const t = TEMPLATES.find((t) => t.name === name);
  if (!t) throw new Error(`unknown template: ${name}`);
  return t.body.replace(/\{\{(\d+)\}\}/g, (all, n) => String(vars[Number(n) - 1] ?? ''));
}

export function templateComponents(vars) {
  return [
    {
      type: 'body',
      parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })),
    },
  ];
}
