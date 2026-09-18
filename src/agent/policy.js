export function canSendProactive({ guest, proactiveSentToday, openRequestCount, kind, cap = 2 }) {
  if (guest.ai_paused) return { ok: false, reason: 'ai_paused' };
  if (guest.whatsapp_opt_in === false) return { ok: false, reason: 'no_whatsapp_opt_in' };
  if (proactiveSentToday >= cap) return { ok: false, reason: 'daily_cap_reached' };
  if (kind === 'activity') {
    if (['checked_out', 'review_requested', 'closed'].includes(guest.journey_state)) {
      return { ok: false, reason: 'after_checkout' };
    }
    if (guest.activities_opt_out) return { ok: false, reason: 'activities_opted_out' };
    if (openRequestCount > 0) return { ok: false, reason: 'open_service_request' };
  }
  if (kind === 'review' && guest.journey_state !== 'checked_out') {
    return { ok: false, reason: 'review_before_checkout' };
  }
  return { ok: true };
}
