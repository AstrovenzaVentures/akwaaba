import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PAYSTACK_SECRET_KEY = 'sk_test_webhooktest';
const { POST } = await import('../api/paystack/webhook.js');

const req = (body, sig) => new Request('https://x/api/paystack/webhook', {
  method: 'POST', body, headers: sig ? { 'x-paystack-signature': sig } : {}
});
const sign = (b) => crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(b).digest('hex');

test('webhook rejects a forged "payment succeeded" call with no signature', async () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'AKW_SUB_x', amount: 10000 } });
  assert.equal((await POST(req(body))).status, 401);
});

test('webhook rejects a signature made with a different key', async () => {
  const body = JSON.stringify({ event: 'charge.success', data: { reference: 'AKW_SUB_x' } });
  const fake = crypto.createHmac('sha512', 'sk_test_attacker').update(body).digest('hex');
  assert.equal((await POST(req(body, fake))).status, 401);
});

test('webhook accepts a signed event it does not act on', async () => {
  const body = JSON.stringify({ event: 'customeridentification.success', data: {} });
  assert.equal((await POST(req(body, sign(body)))).status, 200);
});

test('webhook rejects oversized bodies', async () => {
  const body = 'x'.repeat(100_001);
  assert.equal((await POST(req(body, sign(body)))).status, 413);
});
