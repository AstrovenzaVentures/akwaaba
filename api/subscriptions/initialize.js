// POST /api/subscriptions/initialize
// A signed-in driver starts paying the GHS 100 monthly subscription. Returns the Paystack checkout link.
import { db } from '../../lib/db.js';
import { requireDriver } from '../../lib/auth.js';
import { paystack, newReference } from '../../lib/paystack.js';
import { SUBSCRIPTION_PESEWAS } from '../../lib/pricing.js';
import { json, handle, appUrl } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const driver = await requireDriver(request);
    if (!driver) return json(401, { error: 'Sign in as a driver to pay your subscription.' });
    if (driver.status !== 'approved') return json(403, { error: 'Your driver account is not approved yet.' });

    // Reuse a recent unpaid checkout instead of piling up pending payments.
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const { data: open } = await db().from('payments')
      .select('reference, authorization_url').eq('driver_id', driver.id).eq('kind', 'subscription')
      .eq('status', 'pending').gte('created_at', since).order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (open?.authorization_url) return json(200, { authorization_url: open.authorization_url, reference: open.reference });

    const reference = newReference('SUB');
    const { error: insErr } = await db().from('payments').insert({
      reference, kind: 'subscription', driver_id: driver.id, amount_pesewas: SUBSCRIPTION_PESEWAS
    });
    if (insErr) throw new Error('payment insert failed: ' + insErr.message);

    const tx = await paystack('/transaction/initialize', {
      method: 'POST',
      body: {
        email: driver.email,
        amount: SUBSCRIPTION_PESEWAS,
        currency: 'GHS',
        reference,
        channels: ['mobile_money', 'card'],
        callback_url: `${appUrl()}/payment-complete`,
        metadata: { kind: 'subscription', driver_id: driver.id }
      }
    });
    await db().from('payments').update({ authorization_url: tx.authorization_url }).eq('reference', reference);
    return json(200, { authorization_url: tx.authorization_url, reference });
  });
}
