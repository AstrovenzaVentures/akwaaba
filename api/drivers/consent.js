// POST /api/drivers/consent   body: { "privacy_version": "1.0", "privacy_notice": true, "vetting": true, "marketing": false }
// Records the driver's acknowledgement of the privacy notice, their written consent to vetting checks
// (police clearance is special personal data, Act 843 s.37) and their marketing choice, in the append-only consent ledger.
import { db } from '../../lib/db.js';
import { requireDriver } from '../../lib/auth.js';
import { PRIVACY_NOTICE_VERSION, subjectHash } from '../../lib/privacy.js';
import { json, handle, readJson } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const driver = await requireDriver(request);
    if (!driver) return json(401, { error: 'Sign in as a driver.' });

    const body = await readJson(request);
    if (body?.privacy_version !== PRIVACY_NOTICE_VERSION) return json(400, { error: 'The privacy notice has been updated. Refresh the page and read it again.' });
    if (body.privacy_notice !== true || body.vetting !== true) {
      return json(400, { error: 'To receive pickups, confirm you have read the privacy notice and agree to the vetting checks.' });
    }

    const base = { subject_type: 'driver', subject_hash: subjectHash(driver.phone), notice_version: PRIVACY_NOTICE_VERSION, source: 'driver_app' };
    const rows = [
      { ...base, purpose: 'privacy_notice', granted: true },
      { ...base, purpose: 'driver_vetting', granted: true }
    ];
    // Marketing: record a yes, and record a no only if it changes an earlier yes. No row means no consent.
    const { data: prev } = await db().from('consent_current').select('granted')
      .eq('subject_hash', base.subject_hash).eq('purpose', 'marketing').maybeSingle();
    if (body.marketing === true) rows.push({ ...base, purpose: 'marketing', granted: true });
    else if (prev?.granted) rows.push({ ...base, purpose: 'marketing', granted: false });

    const { error } = await db().from('consent_events').insert(rows);
    if (error) throw new Error('consent insert failed: ' + error.message);
    return json(200, { recorded: rows.map((r) => ({ purpose: r.purpose, granted: r.granted })), at: new Date().toISOString() });
  });
}
