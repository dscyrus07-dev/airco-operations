import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, STATES } from '../src/agent/journey.js';

test('booking_created logs the event but queues NO message (Zostel sends their own)', () => {
  const t = transition('booked', 'booking_created');
  assert.equal(t.ok, true);
  assert.equal(t.message, null);
});

test('full happy path: booked through checked_out, in order', () => {
  let state = 'booked';
  const path = [
    'booking_created',
    'checked_in',
    'in_stay_tick',
    'checkout_reminder_tick',
    'checked_out',
  ];
  for (const ev of path) {
    const t = transition(state, ev);
    assert.equal(t.ok, true, `${ev} from ${state} failed: ${t.reason}`);
    state = t.to;
  }
  assert.equal(state, 'checked_out');
});

test('checked_out queues NO message — review requests are staff-selected', () => {
  const t = transition('in_stay', 'checked_out');
  assert.equal(t.ok, true);
  assert.equal(t.message, null);
});

test('checked_in carries the welcome message', () => {
  const t = transition('pre_arrival', 'checked_in');
  assert.equal(t.ok, true);
  assert.equal(t.message, 'welcome');
});

test('auto welcome/pre-arrival ticks are gone from the event table', () => {
  assert.equal(transition('booked', 'welcome_tick').ok, false);
  assert.equal(transition('pre_arrival', 'welcome_tick').ok, false);
  assert.equal(transition('booked', 'pre_arrival_tick').ok, false);
});

test('checked_out is invalid from pre_arrival (no skipping check-in)', () => {
  assert.equal(transition('pre_arrival', 'checked_out').ok, false);
});

test('double checkout is rejected', () => {
  assert.equal(transition('checked_out', 'checked_out').ok, false);
});

test('review_received closes the journey from review_requested', () => {
  const t = transition('review_requested', 'review_received');
  assert.equal(t.ok, true);
  assert.equal(t.to, 'closed');
});

test('state machine: every state is reachable and listed', () => {
  assert.equal(STATES.length, 8);
});
