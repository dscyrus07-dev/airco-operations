import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifySignature } from '../src/whatsapp/signature.js';

const secret = 'test-app-secret';
const body = Buffer.from(JSON.stringify({ entry: [] }));
const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

test('valid signature passes', () => {
  assert.equal(verifySignature(body, sig, secret), true);
});

test('tampered body fails', () => {
  assert.equal(verifySignature(Buffer.from('{"entry":[1]}'), sig, secret), false);
});

test('signature from a different secret fails', () => {
  assert.equal(verifySignature(body, sig, 'other-secret'), false);
});

test('missing header fails closed', () => {
  assert.equal(verifySignature(body, undefined, secret), false);
});

test('missing body fails closed', () => {
  assert.equal(verifySignature(null, sig, secret), false);
});

test('missing app secret fails closed', () => {
  assert.equal(verifySignature(body, sig, undefined), false);
});
