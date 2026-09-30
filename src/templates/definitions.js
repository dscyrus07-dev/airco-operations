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

// IST wall-clock time like "1:00 PM" — or null when the value carries no real
// time component. Two sentinels: sheet cells without a time parse to 12:30
// (07:00 UTC), and pure DATE columns arrive as midnight UTC.
export function fmtIstTime(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0) return null;
  if (date.getUTCHours() === 7 && date.getUTCMinutes() === 0) return null;
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
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
      'Your Zostel Mumbai stay is just around the corner! 🏠\n' +
      '📅 Check-in: {{2}}\n' +
      '⏰ Check-in from: {{3}}\n' +
      '🕙 Check-out: {{4}}\n' +
      '📍 Reception is open 24/7\n' +
      '🪪 Please keep a valid government ID handy for check-in.\n' +
      'If you\'re arriving early, you\'re welcome to leave your luggage with us while you explore Mumbai.\n' +
      'See you soon!\n' +
      'Team Zostel Mumbai',
  },
  {
    name: 'activity_notice',
    category: 'utility',
    body:
      'Hey {{1}}! �\n' +
      'Something\'s happening at Zostel Mumbai! 🎉\n' +
      '📌 {{2}}\n' +
      '�️ {{3}}\n' +
      '⏰ {{4}}\n' +
      '📍 {{5}}\n' +
      'Come join us, meet fellow travellers and make the most of your Mumbai stay! 🫶\n' +
      'Want to join? Just reply YES and our team will help you out.\n' +
      'See you there!\n' +
      'Team Zostel Mumbai',
  },
  {
    name: 'welcome',
    category: 'utility',
    body:
      'Welcome to Zostel Mumbai, {{1}}! 🎉\n' +
      'We\'re happy to have you here.\n' +
      'Your accommodation details:\n' +
      '🏠 Room: {{2}}\n' +
      'A few useful things for your stay:\n' +
      '📶 Wi-Fi details are available in your room\n' +
      '� In-house Café: 08:30 AM – 10:30 PM\n' +
      '☎️ Reception: 99\n' +
      '☎️ Cafeteria: 88\n' +
      '🕙 Check-out: 10:00 AM\n' +
      'Need anything? Just reach out to our team at reception. We are here round the clock to assist you with everything.\n' +
      'Now go explore Mumbai, meet fellow travellers and make yourself at home! ❤️\n' +
      'Team Zostel Mumbai',
  },
  {
    name: 'checkout_reminder',
    category: 'utility',
    body:
      'Hey {{1}}! 👋\n' +
      'We hope you\'ve had a great time at Zostel Mumbai! ❤️\n' +
      'Just a little reminder that your check-out is tomorrow by 10:00 AM.\n' +
      '🏠 Room: {{2}}\n' +
      'Before you leave:\n' +
      '☑️ Check that you have all your belongings\n' +
      '☑️ Return your keys/access card\n' +
      '☑️ Settle any pending payments\n' +
      'Need help with luggage storage or onward travel? Our reception team will be happy to help.\n' +
      'See you again! ✨\n' +
      'Team Zostel Mumbai',
  },
  {
    name: 'review_request',
    category: 'utility',
    body:
      'Hey {{1}}! 👋\n' +
      'Hope you had an amazing time at Zostel Mumbai! ❤️\n' +
      'If you enjoyed your stay, we\'d love to hear about it. Your review helps fellow travellers discover us and helps our team keep getting better.\n' +
      '⭐ {{2}}\n' +
      'Thank you for staying with us. We hope to see you again on your next adventure!\n' +
      'Team Zostel Mumbai',
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
      return [
        guest.name,
        fmtDate(guest.check_in),
        fmtIstTime(guest.check_in_time ?? guest.check_in) ?? '1:00 PM',
        fmtIstTime(guest.check_out_time ?? guest.check_out) ?? '10:00 AM',
      ];
    case 'welcome':
      return [guest.name, guest.room ?? 'Ask reception'];
    case 'checkout_reminder':
      return [guest.name, guest.room ?? 'See reception'];
    case 'review_request':
      return [guest.name, REVIEW_URL];
    default:
      throw new Error(`unknown template: ${name}`);
  }
}

// Renders {{1}}..{{n}} placeholders with actual values — pure body+vars form
// so the caller can use the effective (dashboard-edited) body.
export function renderBody(body, vars) {
  return String(body ?? '').replace(/\{\{(\d+)\}\}/g, (all, n) => String(vars[Number(n) - 1] ?? ''));
}

export function renderTemplateBody(name, vars) {
  const t = TEMPLATES.find((t) => t.name === name);
  if (!t) throw new Error(`unknown template: ${name}`);
  return renderBody(t.body, vars);
}

export function templateComponents(vars) {
  return [
    {
      type: 'body',
      parameters: vars.map((text) => ({ type: 'text', text: String(text ?? '') })),
    },
  ];
}
