import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplateBody, buildTemplateExamples } from '../src/templates/store.js';
import { TEMPLATES, templateVariables, renderTemplateBody } from '../src/templates/definitions.js';

// FIX 1 (C1): the variable-at-end regex was /{{d+}}s*$/ — matched nothing.
// These tests pin the corrected Meta rule: variables may not start or end a body.

test('FIX 1: body ending in a variable is rejected', () => {
  assert.match(validateTemplateBody('Hey {{1}}\n📅 {{3}} → {{4}}'), /start or end/);
});

test('FIX 1: body starting with a variable is rejected', () => {
  assert.match(validateTemplateBody('{{1}}, your booking is confirmed'), /start or end/);
});

test('FIX 1: body ending in a variable followed by whitespace is rejected', () => {
  assert.match(validateTemplateBody('Hey {{1}}\n📅 {{3}} → {{4}}   '), /start or end/);
});

test('FIX 1: body ending in plain text after a variable is accepted', () => {
  assert.equal(validateTemplateBody('Hey {{1}}\n📅 {{3}} → {{4}}\nNeed anything? Just reply here 😎'), null);
});

test('FIX 1: body with no variables is accepted', () => {
  assert.equal(validateTemplateBody('Hello! Your room is ready.'), null);
});

test('FIX 1: empty body rejected, oversized body rejected', () => {
  assert.match(validateTemplateBody('   '), /required/);
  assert.match(validateTemplateBody('x'.repeat(1025)), /too long/);
});

// FIX 8 (H5): checkin_info is used by BOTH the +1h-after-import trigger and
// the legacy day-before tick — the copy must be timing-neutral and carry the
// actual arrival date.
test('FIX 8: checkin_info copy no longer says "tomorrow"', () => {
  const body = TEMPLATES.find((t) => t.name === 'checkin_info').body;
  assert.ok(!/tomorrow/i.test(body), 'copy must not reference "tomorrow"');
  assert.match(body, /\{\{2\}\}/, 'copy must carry the arrival date variable');
  assert.equal(validateTemplateBody(body), null, 'new body must pass Meta variable-position rules');
});

test('FIX 8: rendered checkin_info shows the real arrival date for a 3-days-out import', () => {
  const vars = templateVariables('checkin_info', { name: 'Vedank', check_in: '2026-09-29', check_out: '2026-09-30' });
  assert.equal(vars.length, 2);
  assert.match(vars[1], /Sep/, `arrival formatted, got: ${vars[1]}`);
  const rendered = renderTemplateBody('checkin_info', vars);
  assert.ok(!/tomorrow/i.test(rendered));
  assert.match(rendered, /checking in at Zostel Mumbai on 29 Sep/);
  assert.match(rendered, /Vedank/);
});

// Editor follow-up: edits that ADD variables must fill example gaps —
// Meta rejects (2388043) when any variable lacks an example.
test('FIX 8: buildTemplateExamples fills gaps when variables are added', () => {
  assert.deepEqual(buildTemplateExamples({ 1: 'Cyrus' }, 2), { 1: 'Cyrus', 2: '29 Sep' });
  assert.deepEqual(buildTemplateExamples({}, 4), { 1: 'Cyrus', 2: '29 Sep', 3: '30 Sep', 4: 'Room 203' });
  assert.deepEqual(buildTemplateExamples({ 1: 'A', 2: 'B', 3: 'C' }, 2), { 1: 'A', 2: 'B' });
});
