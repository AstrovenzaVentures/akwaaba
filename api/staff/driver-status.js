// POST /api/staff/driver-status   Staff only.
// body: { "driver_id": "<uuid>", "action": "approve" | "suspend" | "reinstate", "checks": ["ghana_card", ...], "note": "..." }
// Approval requires all five document checks to be confirmed; each is recorded in driver_vetting (results only, no copies).
import { db } from '../../lib/db.js';
import { requireStaff } from '../../lib/auth.js';
import { VETTING_CHECKS } from '../../lib/applicant.js';
import { subjectHash } from '../../lib/privacy.js';
import { clean } from '../../lib/validate.js';
import { json, handle, readJson } from '../../lib/http.js';

const NEXT = { approve: 'approved', suspend: 'suspended', reinstate: 'approved' };
const FROM = { approve: ['pending_review'], suspend: ['pending_review', 'approved'], reinstate: ['suspended'] };

export async function POST(request) {
  return handle(async () => {
    const staff = await requireStaff(request);
    if (!staff) return json(401, { error: 'Staff sign-in with your authenticator code is required.' });

    const body = await readJson(request);
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
      const { data: consent } = await db().from('consent_events').select('id')
        .eq('subject_hash', subjectHash(d.phone)).eq('purpose', 'driver_vetting').eq('granted', true)
        .order('created_at', { ascending: false }).limit(1).maybeSingle();
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
