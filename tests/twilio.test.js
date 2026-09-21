import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyTwilioSignature, classifyTwilioEvent } from '../src/whatsapp/twilio-webhook.js';

const authToken = 'test-twilio-auth-token';
const url = 'https://airco-operations-production.up.railway.app/webhook/twilio';

function twilioSign(token, url, params) {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  return crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
}

const inboundParams = {
  MessageSid: 'SMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  From: 'whatsapp:+918855994761',
  To: 'whatsapp:+14155238886',
  Body: 'hi',
  NumMedia: '0',
  ProfileName: 'Cyrus',
};

test('twilio: valid signature passes', () => {
  const sig = twilioSign('test-twilio-auth-token', url, inboundParams);
  assert.equal(verifyTwilioSignature('test-twilio-auth-token', sig, url, inboundParams), true);
});

test('twilio: tampered params fail', () => {
  const sig = twilioSign('test-twilio-auth-token', url, inboundParams);
  assert.equal(
    verifyTwilioSignature('test-twilio-auth-token', sig, url, { ...inboundParams, Body: 'evil' }),
    false
  );
});

test('twilio: wrong token fails', () => {
  const sig = twilioSign('test-twilio-auth-token', url, inboundParams);
  assert.equal(verifyTwilioSignature('other-token', sig, url, inboundParams), false);
});

test('twilio: missing signature fails closed', () => {
  assert.equal(verifyTwilioSignature('test-twilio-auth-token', undefined, url, inboundParams), false);
});

test('twilio: missing auth token fails closed', () => {
  const sig = twilioSign('test-twilio-auth-token', url, inboundParams);
  assert.equal(verifyTwilioSignature(undefined, sig, url, inboundParams), false);
});

test('twilio: inbound whatsapp message classified with digits-only phone', () => {
  const res = classifyTwilioEvent(inboundParams);
  assert.equal(res.kind, 'inbound');
  assert.equal(res.phone, '918855994761');
});

test('twilio: status callback classified as status', () => {
  const res = classifyTwilioEvent({ MessageSid: 'SMxxxx', MessageStatus: 'delivered' });
  assert.equal(res.kind, 'status');
  assert.equal(res.messageStatus, 'delivered');
});

test('twilio: undelivered maps to failed status', () => {
  const res = classifyTwilioEvent({ MessageSid: 'SMxxxx', MessageStatus: 'undelivered' });
  assert.equal(res.kind, 'status');
});

test('twilio: unrelated payload is ignored', () => {
  const res = classifyTwilioEvent({ Foo: 'bar' });
  assert.equal(res.kind, 'ignored');
});
