// POST /api/paystack/webhook
// Paystack calls this after driver subscription payments (the only payments Woezor takes). Set this address in the Paystack dashboard.
import { validSignature } from '../../lib/paystack.js';
import { settlePayment } from '../../lib/settle.js';

export async function POST(request) {
  const raw = await request.text(); // raw body is required for the signature check
  if (raw.length > 100_000) return new Response('too large', { status: 413 });
  if (!validSignature(raw, request.headers.get('x-paystack-signature'))) {
    console.warn('[woezor] webhook rejected: bad signature');
    return new Response('invalid signature', { status: 401 });
  }

  let event;
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  const ref = event?.data?.reference;

  if (event.event === 'charge.success' && typeof ref === 'string' && /^(AKW|WZR)_SUB_/.test(ref)) {
    try {
      const result = await settlePayment(ref);
      console.log('[woezor] charge.success', ref, result.outcome);
    } catch (err) {
      // A 5xx makes Paystack retry later. Settlement is idempotent, so retries are safe.
      console.error('[woezor] webhook processing failed', ref, err.message);
      return new Response('retry', { status: 500 });
    }
  }
  return new Response('ok', { status: 200 });
}
