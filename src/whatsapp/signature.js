import crypto from 'node:crypto';

// Twilio request signature: HMAC-SHA1 over the full request URL followed by
// each POST parameter (alphabetically sorted) concatenated as key+value,
// base64-encoded. Header: X-Twilio-Signature.
export function verifyTwilioSignature(authToken, signature, url, params) {
  if (!authToken || !signature || !url) return false;
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], String(url));
  const expected = crypto
    .createHmac('sha1', authToken)
    .update(Buffer.from(data, 'utf8'))
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
