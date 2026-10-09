// POST /api/subscriptions/initialize
// A signed-in driver pays the GHS 100 monthly subscription.
//   {}                                   -> Paystack checkout link (card or mobile money, switches on at once)
//   { method: 'mtn'|'telecel'|'airteltigo'|'bank', txn_id, payer_account, proof: { type, data(base64) } }
//                                        -> a direct payment to Astrovenza, held until staff confirm it
import { db } from '../../lib/db.js';
import { activeAccounts, parseClaim, PROOF_BUCKET } from '../../lib/manual-payment.js';
import { requireDriver } from '../../lib/auth.js';
import { paystack, newReference } from '../../lib/paystack.js';
import { SUBSCRIPTION_PESEWAS } from '../../lib/pricing.js';
import { json, handle, appUrl, readJson } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const driver = await requireDriver(request);
    if (!driver) return json(401, { error: 'Sign in as a driver to pay your subscription.' });
    if (driver.status !== 'approved') return json(403, { error: 'Your driver account is not approved yet.' });

    const body = (await readJson(request, 4_400_000)) || {};
    if (body.method) return manualClaim(driver, body);

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

async function manualClaim(driver, body) {
  const accounts = await activeAccounts();
  const claim = parseClaim(body, accounts);
  if (claim.error) return json(400, { error: claim.error });

  const { data: open } = await db().from('payments').select('reference')
    .eq('driver_id', driver.id).eq('status', 'submitted').limit(1).maybeSingle();
  if (open) return json(409, { error: 'Your last payment is still being checked. You will see the result here.' });

  const reference = newReference('MAN');
  const path = `${driver.id}/${reference}.${claim.proof.ext}`;
  const { error: upErr } = await db().storage.from(PROOF_BUCKET)
    .upload(path, claim.proof.buffer, { contentType: claim.proof.type, upsert: false });
  if (upErr) throw new Error('proof upload failed: ' + upErr.message);

  const { error: insErr } = await db().from('payments').insert({
    reference, kind: 'subscription', driver_id: driver.id, amount_pesewas: SUBSCRIPTION_PESEWAS,
    status: 'submitted', method: claim.method, manual_txn_id: claim.txnId, payer_account: claim.payer, proof_path: path
  });
  if (insErr) {
    await db().storage.from(PROOF_BUCKET).remove([path]);
    if (insErr.code === '23505') {
      return json(409, { error: /one_open/.test(insErr.message)
        ? 'Your last payment is still being checked. You will see the result here.'
        : 'That transaction ID has already been used. Check the ID in your payment message.' });
    }
    throw new Error('manual payment insert failed: ' + insErr.message);
  }
  await db().from('audit_log').insert({ actor: driver.id, action: 'manual_payment_submitted', target: reference, detail: { method: claim.method } });
  return json(200, { reference, status: 'submitted' });
}
