// POST /api/drivers/apply   (Authorization: Bearer <session from the email code sign-in on /apply>)
// Creates the signed-in person's driver profile as "pending_review". They get no pickups and cannot pay
// until staff have checked their documents and approved them.
import { db } from '../../lib/db.js';
import { signedInUser } from '../../lib/auth.js';
import { parseApplication } from '../../lib/applicant.js';
import { PRIVACY_NOTICE_VERSION, subjectHash } from '../../lib/privacy.js';
import { json, handle, readJson } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const user = await signedInUser(request);
    if (!user?.email) return json(401, { error: 'Confirm your email address first.' });

    const { data: a, error } = parseApplication(await readJson(request));
    if (error) return json(400, { error });

    const { data: existing } = await db().from('drivers').select('status').eq('id', user.id).maybeSingle();
    if (existing) return json(409, { error: 'You have already applied. Sign in to the driver app to see your status.', status: existing.status });

    const { data: airport } = await db().from('airports').select('code').eq('code', a.baseAirport).eq('active', true).maybeSingle();
    if (!airport) return json(400, { error: 'Choose the airport you will work from.' });

    const { error: insErr } = await db().from('drivers').insert({
      id: user.id, name: a.name, phone: a.phone, email: user.email.toLowerCase(),
      vehicle_type: a.vehicleType, vehicle_model: a.vehicleModel, plate: a.plate,
      base_airport: a.baseAirport, status: 'pending_review'
    });
    if (insErr) {
      if (/phone/.test(insErr.message)) return json(409, { error: 'That WhatsApp number is already registered with Woezor.' });
      if (/plate/.test(insErr.message)) return json(409, { error: 'That registration plate is already registered with Woezor.' });
      throw new Error('driver insert failed: ' + insErr.message);
    }

    // Written consent, recorded in the append-only ledger (vetting covers police clearance: Act 843 s.37).
    const base = { subject_type: 'driver', subject_hash: subjectHash(a.phone), notice_version: PRIVACY_NOTICE_VERSION, source: 'driver_application' };
    const rows = [{ ...base, purpose: 'privacy_notice', granted: true }, { ...base, purpose: 'driver_vetting', granted: true }];
    if (a.marketing) rows.push({ ...base, purpose: 'marketing', granted: true });
    const { error: cErr } = await db().from('consent_events').insert(rows);
    if (cErr) throw new Error('consent insert failed: ' + cErr.message);

    await db().from('audit_log').insert({ actor: user.id, action: 'driver_applied', target: user.id, detail: { base_airport: a.baseAirport, vehicle_type: a.vehicleType } });
    return json(200, { status: 'pending_review' });
  });
}
