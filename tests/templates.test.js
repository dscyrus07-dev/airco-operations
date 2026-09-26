import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTemplateBody } from '../src/templates/store.js';

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
