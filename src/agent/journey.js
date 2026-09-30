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
  // Zostel's own PMS already sends booking confirmations — we never do.
  // The event is still logged for the timeline; it just queues no message.
  booking_created: {
    from: ['booked'],
    to: 'booked',
    message: null,
    messageKind: 'journey',
  },
  checked_in: {
    from: ['booked', 'pre_arrival'],
    to: 'checked_in',
    message: 'welcome',
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
  // Review requests are STAFF-SELECTED from the "Checking out today" list —
  // checkout itself queues nothing (state still moves to checked_out).
  checked_out: {
    from: ['checkout_pending', 'in_stay', 'checked_in'],
    to: 'checked_out',
    message: null,
    messageKind: 'journey',
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
    to: ev.to === 'self' ? currentState : ev.to,
    message: ev.message,
    messageKind: ev.messageKind,
  };
}
