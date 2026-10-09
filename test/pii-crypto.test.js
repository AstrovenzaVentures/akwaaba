import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const k1 = crypto.randomBytes(32).toString('base64'), k2 = crypto.randomBytes(32).toString('base64');
process.env.PII_ENC_KEYS = `v1:${k1}`;
process.env.PII_INDEX_KEY = crypto.randomBytes(32).toString('base64');
const m = await import('../lib/pii-crypto.js');

test('encrypts and decrypts a field; ciphertext hides the value', () => {
  const e = m.encryptField('+233244112087', 'bookings.passenger_phone');
  assert.match(e, /^v1:/);
  assert.ok(!e.includes('233244112087'));
  assert.equal(m.decryptField(e, 'bookings.passenger_phone'), '+233244112087');
});

test('a value moved to another column, or tampered with, fails to decrypt', () => {
  const e = m.encryptField('+233244112087', 'bookings.passenger_phone');
  assert.throws(() => m.decryptField(e, 'bookings.dest_address'));
  const p = e.split(':'); p[3] = Buffer.from('tampered').toString('base64');
  assert.throws(() => m.decryptField(p.join(':'), 'bookings.passenger_phone'));
});

test('blind index is stable and purpose-separated', () => {
  assert.equal(m.blindIndex('+233244112087'), m.blindIndex(' +233244112087 '));
  assert.notEqual(m.blindIndex('+233244112087', 'phone'), m.blindIndex('+233244112087', 'email'));
});

test('key rotation: old values still readable, new values use the new key', () => {
  const e = m.encryptField('Ama', 'bookings.passenger_name');
  process.env.PII_ENC_KEYS = `v2:${k2},v1:${k1}`;
  assert.equal(m.decryptField(e, 'bookings.passenger_name'), 'Ama');
  assert.equal(m.needsRotation(e), true);
  assert.match(m.encryptField('Kofi', 'bookings.passenger_name'), /^v2:/);
  process.env.PII_ENC_KEYS = `v1:${k1}`;
});

test('malformed keys are refused', () => {
  const keep = process.env.PII_ENC_KEYS;
  process.env.PII_ENC_KEYS = 'v1:short';
  assert.throws(() => m.encryptField('x', 'a'), /malformed/);
  process.env.PII_ENC_KEYS = keep;
});
