// GET /api/payments/verify?reference=...
// The payment-complete page calls this after Paystack sends a driver back from paying the subscription.
// It settles the payment if the webhook has not arrived yet, and returns only the status.
import { db } from '../../lib/db.js';
import { settlePayment } from '../../lib/settle.js';
import { json, handle } from '../../lib/http.js';

export async function GET(request) {
  return handle(async () => {
    const reference = new URL(request.url).searchParams.get('reference') || '';
    if (!/^AKW_SUB_[a-f0-9]{32}$/.test(reference)) return json(400, { error: 'Invalid payment reference.' });

    let { data: p } = await db().from('payments').select('status').eq('reference', reference).maybeSingle();
    if (!p) return json(404, { error: 'Payment not found.' });
    if (p.status === 'pending') {
      await settlePayment(reference);
      ({ data: p } = await db().from('payments').select('status').eq('reference', reference).maybeSingle());
    }
    const status = p.status === 'success' ? 'paid' : p.status === 'pending' ? 'pending' : 'needs_review';
    return json(200, { status, kind: 'subscription' });
  });
}
