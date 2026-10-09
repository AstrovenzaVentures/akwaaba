import { db } from './db.js';
import { paystack } from './paystack.js';
import { SUBSCRIPTION_DAYS } from './pricing.js';

// Applies a successful Paystack subscription payment exactly once.
// Called by the webhook and by the verify endpoint; whichever runs first wins, the other is a no-op.
export async function settlePayment(reference) {
  const { data: payment } = await db().from('payments').select('*').eq('reference', reference).maybeSingle();
  if (!payment) return { outcome: 'unknown_reference' };
  if (payment.status !== 'pending') return { outcome: 'already_' + payment.status, payment };

  // Never trust the webhook body or the browser: ask Paystack directly.
  const tx = await paystack(`/transaction/verify/${encodeURIComponent(reference)}`);
  if (tx.status !== 'success') return { outcome: 'not_paid', payment };

  if (tx.amount !== payment.amount_pesewas || tx.currency !== 'GHS') {
    await db().from('payments')
      .update({ status: 'flagged', note: `Paid ${tx.amount} ${tx.currency}, expected ${payment.amount_pesewas} GHS` })
      .eq('reference', reference).eq('status', 'pending');
    return { outcome: 'flagged_amount_mismatch', payment };
  }

  // One database transaction: marks the payment paid and extends the driver's subscription.
  const { data: outcome, error } = await db().rpc('apply_payment', {
    p_reference: reference,
    p_paystack_id: tx.id,
    p_paid_at: tx.paid_at || new Date().toISOString(),
    p_channel: tx.channel || null,
    p_sub_days: SUBSCRIPTION_DAYS
  });
  if (error) throw new Error('apply_payment failed: ' + error.message);
  return { outcome, payment };
}
