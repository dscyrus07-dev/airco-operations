export const STATES = [
  'booked',
  'pre_arrival',
  'checked_in',
  'in_stay',
  'checkout_pending',
  'checked_out',
  'review_requested',
  'closed',
];

// Deterministic transition table. Only explicit events move the state — never the LLM.
export const EVENTS = {
  booking_created: {
    from: ['booked'],
    to: 'booked',
    message: 'booking_confirmation',
    messageKind: 'journey',
  },
  pre_arrival_tick: {
    from: ['booked'],
    to: 'pre_arrival',
    message: 'checkin_info',
    messageKind: 'journey',
  },
  checked_in: {
    from: ['booked', 'pre_arrival'],
    to: 'checked_in',
    message: null,
    messageKind: 'journey',
  },
  in_stay_tick: {
    from: ['checked_in'],
    to: 'in_stay',
    message: null,
    messageKind: 'journey',
  },
  checkout_reminder_tick: {
    from: ['checked_in', 'in_stay'],
    to: 'checkout_pending',
    message: 'checkout_reminder',
    messageKind: 'journey',
  },
  checked_out: {
    from: ['checkout_pending', 'in_stay', 'checked_in'],
    to: 'checked_out',
    message: 'review_request',
    messageKind: 'review',
  },
  review_received: {
    from: ['review_requested'],
    to: 'closed',
    message: null,
    messageKind: 'journey',
  },
};

export function transition(currentState, eventName) {
  const ev = EVENTS[eventName];
  if (!ev) return { ok: false, reason: `unknown_event:${eventName}` };
  if (!ev.from.includes(currentState)) {
    return { ok: false, reason: `invalid_transition:${currentState}+${eventName}` };
  }
  return {
    ok: true,
    to: ev.to,
    message: ev.message,
    messageKind: ev.messageKind,
  };
}
