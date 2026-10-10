// Direct payments to Astrovenza (MoMo or bank) with a screenshot as proof. Staff confirm each one
// against the real statement before the subscription is switched on.
import { db } from './db.js';
import { clean } from './validate.js';

export const MANUAL_METHODS = ['mtn', 'telecel', 'airteltigo', 'bank'];
export const PROOF_BUCKET = 'payment-proofs';
export const PROOF_MAX_BYTES = 3 * 1024 * 1024;
export const PROOF_KEEP_DAYS = 90;

const TYPES = {
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  'image/webp': { ext: 'webp', magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' }
};

// Active accounts drivers may pay into, in display order. Rows still holding "FILL IN" are never shown.
export async function activeAccounts() {
  const { data, error } = await db().from('payment_accounts')
    .select('method, label, account_name, account_number, bank_name, branch, instructions, active, sort')
    .eq('active', true).order('sort');
  if (error) throw new Error('payment_accounts query failed: ' + error.message);
  return (data || []).filter((a) => ![a.account_number, a.account_name, a.bank_name, a.branch].some((v) => /fill in/i.test(v || '')))
    .map(({ active, sort, ...a }) => a);
}

// Validates a driver's claim. Returns { error } or { method, txnId, payer, proof: { buffer, type, ext } }.
export function parseClaim(body, accounts) {
  const method = clean(body?.method, 12);
  if (!MANUAL_METHODS.includes(method) || !accounts.some((a) => a.method === method)) {
    return { error: 'Choose how you paid.' };
  }
  const txnId = clean(body.txn_id, 40).replace(/\s+/g, '');
  if (!/^[A-Za-z0-9][A-Za-z0-9.\-/]{3,39}$/.test(txnId)) {
    return { error: 'Enter the transaction ID from your payment message (letters and numbers, at least 4).' };
  }
  const payer = clean(body.payer_account, 40);
  if (payer.length < 3) return { error: 'Enter the number or account you paid from.' };

  const type = clean(body.proof?.type, 20);
  const info = TYPES[type];
  const b64 = typeof body.proof?.data === 'string' ? body.proof.data : '';
  if (!info || !b64) return { error: 'Add a screenshot of your payment (JPG or PNG).' };
  if (b64.length > Math.ceil(PROOF_MAX_BYTES / 3) * 4 + 4) return { error: 'The screenshot is too large. Use a smaller image.' };
  const buffer = Buffer.from(b64, 'base64');
  if (buffer.length < 100 || buffer.length > PROOF_MAX_BYTES || !info.magic(buffer)) {
    return { error: 'That file is not a readable picture. Add a screenshot (JPG or PNG).' };
  }
  return { method, txnId, payer, proof: { buffer, type, ext: info.ext } };
}

// Deletes screenshots of payments decided more than PROOF_KEEP_DAYS ago (privacy policy, section 9).
export async function purgeOldProofs(limit = 50) {
  const cutoff = new Date(Date.now() - PROOF_KEEP_DAYS * 864e5).toISOString();
  const { data } = await db().from('payments').select('reference, proof_path')
    .not('proof_path', 'is', null).lt('reviewed_at', cutoff).limit(limit);
  if (!data?.length) return 0;
  const { error } = await db().storage.from(PROOF_BUCKET).remove(data.map((p) => p.proof_path));
  if (error) { console.error('[woezor] proof purge failed:', error.message); return 0; }
  await db().from('payments').update({ proof_path: null }).in('reference', data.map((p) => p.reference));
  return data.length;
}
