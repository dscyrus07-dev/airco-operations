import test from 'node:test';
import assert from 'node:assert/strict';
import { canSendProactive } from '../src/agent/policy.js';

const baseGuest = { ai_paused: false, journey_state: 'in_stay' };

test('journey message within cap is allowed', () => {
  const d = canSendProactive({ guest: baseGuest, proactiveSentToday: 0, openRequestCount: 0, kind: 'journey', cap: 2 });
  assert.deepEqual(d, { ok: true });
});

test('third proactive message same day is blocked (cap 2)', () => {
  const d = canSendProactive({ guest: baseGuest, proactiveSentToday: 2, openRequestCount: 0, kind: 'journey', cap: 2 });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'daily_cap_reached');
});

test('activity messages are blocked after checkout', () => {
  const d = canSendProactive({
    guest: { ...baseGuest, journey_state: 'checked_out' },
    proactiveSentToday: 0,
    openRequestCount: 0,
    kind: 'activity',
    cap: 2,
  });
  assert.equal(d.reason, 'after_checkout');
});

test('activity messages are blocked while a service request is open', () => {
  const d = canSendProactive({ guest: baseGuest, proactiveSentToday: 0, openRequestCount: 1, kind: 'activity', cap: 2 });
  assert.equal(d.reason, 'open_service_request');
});

test('guest opted out of activities blocks activity kind', () => {
  const d = canSendProactive({
    guest: { ...baseGuest, activities_opt_out: true },
    proactiveSentToday: 0,
    openRequestCount: 0,
    kind: 'activity',
    cap: 2,
  });
  assert.equal(d.reason, 'activities_opted_out');
});

test('activity opt-out does not block journey messages', () => {
  const d = canSendProactive({
    guest: { ...baseGuest, activities_opt_out: true },
    proactiveSentToday: 0,
    openRequestCount: 0,
    kind: 'journey',
    cap: 2,
  });
  assert.deepEqual(d, { ok: true });
});

test('review request is blocked before checkout is confirmed', () => {
  const d = canSendProactive({ guest: baseGuest, proactiveSentToday: 0, openRequestCount: 0, kind: 'review', cap: 2 });
  assert.equal(d.reason, 'review_before_checkout');
});

test('review request is allowed only from checked_out', () => {
  const d = canSendProactive({
    guest: { ...baseGuest, journey_state: 'checked_out' },
    proactiveSentToday: 0,
    openRequestCount: 0,
    kind: 'review',
    cap: 2,
  });
  assert.equal(d.ok, true);
});

test('ai_paused blocks everything automatically', () => {
  const d = canSendProactive({
    guest: { ...baseGuest, ai_paused: true },
    proactiveSentToday: 0,
    openRequestCount: 0,
    kind: 'journey',
    cap: 2,
  });
  assert.equal(d.reason, 'ai_paused');
});
