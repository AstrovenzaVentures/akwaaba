// /api/staff/drivers   Staff only (password + authenticator code).
// GET:  applicants and drivers, newest first, with subscription status and recorded vetting checks.
// POST: { "driver_id": "<uuid>", "action": "approve" | "suspend" | "reinstate", "checks": [...], "note": "..." }
//       Approval requires all five document checks; each is recorded in driver_vetting (results only, no copies).
// POST: { "payment_reference": "...", "action": "confirm_payment" | "reject_payment", "note": "reason" }
//       Decides a direct MoMo/bank payment after staff have checked it against the real statement.
import { db } from '../../lib/db.js';
import { requireStaff } from '../../lib/auth.js';
import { VETTING_CHECKS } from '../../lib/applicant.js';
import { subjectHash } from '../../lib/privacy.js';
import { clean } from '../../lib/validate.js';
import { PROOF_BUCKET, purgeOldProofs } from '../../lib/manual-payment.js';
import { SUBSCRIPTION_DAYS } from '../../lib/pricing.js';
import { json, handle, readJson } from '../../lib/http.js';

export async function GET(request) {
  return handle(async () => {
    const staff = await requireStaff(request);
    if (!staff) return json(401, { error: 'Staff sign-in with your authenticator code is required.' });

    const { data: drivers, error } = await db().from('drivers')
      .select('id, name, phone, email, vehicle_type, vehicle_model, plate, base_airport, status, sub_until, created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error('drivers query failed: ' + error.message);

    // Vetting checks for the listed drivers, 100 ids per request to keep each request small.
    const checks = [];
    for (let i = 0; i < drivers.length; i += 100) {
      const { data } = await db().from('driver_vetting').select('driver_id, check_type, result, checked_at')
        .in('driver_id', drivers.slice(i, i + 100).map((d) => d.id));
      checks.push(...(data || []));
    }
    // Payment history (paid, rejected or flagged; newest first), 100 drivers per request.
    const history = [];
    for (let i = 0; i < drivers.length; i += 100) {
      const { data } = await db().from('payments')
        .select('driver_id, method, status, amount_pesewas, paid_at, created_at, reviewed_by, reviewed_at, manual_txn_id, reject_reason')
        .in('driver_id', drivers.slice(i, i + 100).map((d) => d.id))
        .in('status', ['success', 'rejected', 'flagged'])
        .order('created_at', { ascending: false }).limit(2000);
      history.push(...(data || []));
    }
    // Who confirmed or rejected: staff emails, looked up once per reviewer.
    const reviewers = {};
    for (const id of [...new Set(history.map((h) => h.reviewed_by).filter(Boolean))]) {
      const { data } = await db().auth.admin.getUserById(id).catch(() => ({ data: null }));
      reviewers[id] = data?.user?.email || 'staff';
    }

    // Direct payments waiting for a decision, each with a 10-minute private link to the screenshot.
    await purgeOldProofs().catch((e) => console.error('[akwaaba] purge', e?.message));
    const { data: claims } = await db().from('payments')
      .select('reference, driver_id, method, manual_txn_id, payer_account, amount_pesewas, proof_path, created_at')
      .eq('status', 'submitted').order('created_at').limit(100);
    const payments = [];
    for (const c of claims || []) {
      const { data: link } = c.proof_path
        ? await db().storage.from(PROOF_BUCKET).createSignedUrl(c.proof_path, 600) : { data: null };
      const d = drivers.find((x) => x.id === c.driver_id);
      const { proof_path, ...rest } = c;
      payments.push({ ...rest, driver_name: d?.name || '', driver_phone: d?.phone || '', driver_plate: d?.plate || '', proof_url: link?.signedUrl || null });
    }
    const now = Date.now();
    return json(200, {
      staff: { email: staff.email, role: staff.role },
      payments,
      drivers: drivers.map((d) => ({
        ...d,
        subscription_active: !!d.sub_until && new Date(d.sub_until).getTime() > now,
        checks: checks.filter((c) => c.driver_id === d.id).map(({ driver_id, ...c }) => c),
        payments: history.filter((h) => h.driver_id === d.id).slice(0, 24)
          .map(({ driver_id, reviewed_by, ...h }) => ({ ...h, reviewed_by: reviewed_by ? reviewers[reviewed_by] : null }))
      }))
    });
  });
}

const NEXT = { approve: 'approved', suspend: 'suspended', reinstate: 'approved' };
const FROM = { approve: ['pending_review'], suspend: ['pending_review', 'approved'], reinstate: ['suspended'] };

export async function POST(request) {
  return handle(async () => {
    const staff = await requireStaff(request);
    if (!staff) return json(401, { error: 'Staff sign-in with your authenticator code is required.' });

    const body = await readJson(request);
    if (body?.payment_reference) return decidePayment(staff, body);
    const id = clean(body?.driver_id, 40);
    const action = clean(body?.action, 12);
    const note = clean(body?.note, 300);
    if (!/^[0-9a-f-]{36}$/.test(id) || !NEXT[action]) return json(400, { error: 'Invalid request.' });

    const { data: d } = await db().from('drivers').select('id, phone, status').eq('id', id).maybeSingle();
    if (!d) return json(404, { error: 'Driver not found.' });
    if (!FROM[action].includes(d.status)) return json(409, { error: `This driver is ${d.status.replace('_', ' ')}; refresh the list.` });

    if (action === 'approve') {
      const checks = Array.isArray(body.checks) ? body.checks : [];
      if (!VETTING_CHECKS.every((c) => checks.includes(c))) {
        return json(400, { error: 'Confirm all five document checks before approving.' });
      }
      // The driver's current choice must be "granted" (a later withdrawal wins), then link the latest grant.
      const { data: current } = await db().from('consent_current').select('granted')
        .eq('subject_hash', subjectHash(d.phone)).eq('purpose', 'driver_vetting').maybeSingle();
      const { data: consent } = current?.granted ? await db().from('consent_events').select('id')
        .eq('subject_hash', subjectHash(d.phone)).eq('purpose', 'driver_vetting').eq('granted', true)
        .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1).maybeSingle() : { data: null };
      if (!consent) return json(409, { error: 'This driver has not given written consent to vetting checks. Ask them to sign in to the driver app and accept it.' });
      const { error } = await db().from('driver_vetting').insert(VETTING_CHECKS.map((c) => ({
        driver_id: id, check_type: c, result: 'pass', provider: 'staff_visual_check',
        consent_event_id: consent.id, checked_by: staff.user_id
      })));
      if (error) throw new Error('vetting insert failed: ' + error.message);
    }

    const { data: updated, error } = await db().from('drivers').update({ status: NEXT[action] })
      .eq('id', id).in('status', FROM[action]).select('id, status').maybeSingle();
    if (error) throw new Error('status update failed: ' + error.message);
    if (!updated) return json(409, { error: 'The driver changed in the meantime; refresh the list.' });

    await db().from('audit_log').insert({ actor: staff.user_id, action: `driver_${action}`, target: id, detail: note ? { note } : null });
    return json(200, updated);
  });
}

async function decidePayment(staff, body) {
  const reference = clean(body.payment_reference, 60);
  const action = clean(body.action, 20);
  const note = clean(body.note, 300);
  if (!/^AKW_MAN_[0-9a-f]{32}$/.test(reference) || !['confirm_payment', 'reject_payment'].includes(action)) {
    return json(400, { error: 'Invalid request.' });
  }
  const approve = action === 'confirm_payment';
  if (!approve && note.length < 3) return json(400, { error: 'Give the driver a reason, for example "No payment with this ID on our statement".' });

  const { data: outcome, error } = await db().rpc('review_manual_payment', {
    p_reference: reference, p_staff: staff.user_id, p_approve: approve, p_reason: approve ? null : note, p_sub_days: SUBSCRIPTION_DAYS
  });
  if (error) throw new Error('review_manual_payment failed: ' + error.message);
  if (outcome === 'already_handled') return json(409, { error: 'This payment was already decided; refresh the list.' });

  await db().from('audit_log').insert({ actor: staff.user_id, action: `manual_payment_${approve ? 'confirmed' : 'rejected'}`, target: reference, detail: note ? { note } : null });
  return json(200, { outcome });
}
