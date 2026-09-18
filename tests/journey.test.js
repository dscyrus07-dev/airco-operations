import test from 'node:test';
import assert from 'node:assert/strict';
import { transition, STATES } from '../src/agent/journey.js';

test('booking_created from booked queues booking_confirmation', () => {
  const t = transition('booked', 'booking_created');
  assert.equal(t.ok, true);
  assert.equal(t.message, 'booking_confirmation');
});

test('full happy path: booked through checked_out, in order', () => {
  let state = 'booked';
  const path = [
    'booking_created',
    'pre_arrival_tick',
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

test('review_request template only rides the checked_out event', () => {
  const t = transition('in_stay', 'checked_out');
  assert.equal(t.ok, true);
  assert.equal(t.message, 'review_request');
  assert.equal(t.messageKind, 'review');
});

test('welcome_tick from booked is a self-transition carrying the welcome message', () => {
  const t = transition('booked', 'welcome_tick');
  assert.equal(t.ok, true);
  assert.equal(t.to, 'booked'); // state unchanged — staff check-in moves it
  assert.equal(t.message, 'welcome');
});

test('welcome_tick from pre_arrival also delivers the welcome', () => {
  const t = transition('pre_arrival', 'welcome_tick');
  assert.equal(t.ok, true);
  assert.equal(t.to, 'pre_arrival');
  assert.equal(t.message, 'welcome');
});

test('checked_in now carries the welcome message', () => {
  const t = transition('pre_arrival', 'checked_in');
  assert.equal(t.ok, true);
  assert.equal(t.message, 'welcome');
});

test('welcome_tick is rejected once the guest is checked in (no duplicate welcome)', () => {
  assert.equal(transition('checked_in', 'welcome_tick').ok, false);
  assert.equal(transition('in_stay', 'welcome_tick').ok, false);
});

test('checked_out is invalid from pre_arrival (no skipping check-in)', () => {
  assert.equal(transition('pre_arrival', 'checked_out').ok, false);
});

test('duplicate checkout event is rejected', () => {
  assert.equal(transition('checked_out', 'checked_out').ok, false);
});

test('LLM-invented events are rejected — only explicit events move state', () => {
  assert.equal(transition('booked', 'agent_thinks_guest_left').ok, false);
  assert.equal(transition('in_stay', 'llm_decided').ok, false);
});

test('all reachable states are in STATES', () => {
  const reachable = new Set(['booked']);
  for (const ev of Object.values(require_events())) {
    reachable.add(ev.to);
  }
  for (const s of reachable) assert.ok(STATES.includes(s), `unknown state ${s}`);
});

function require_events() {
  return {
    booking_created: { to: 'booked' },
    pre_arrival_tick: { to: 'pre_arrival' },
    welcome_tick: { to: 'booked' },
    checked_in: { to: 'checked_in' },
    in_stay_tick: { to: 'in_stay' },
    checkout_reminder_tick: { to: 'checkout_pending' },
    checked_out: { to: 'checked_out' },
    review_received: { to: 'closed' },
  };
}
