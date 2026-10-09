// What a signed-in driver may see and do: passenger details only once they have accepted the current
// privacy notice and vetting consent, and nothing while their account is suspended.
import { db } from './db.js';
import { PRIVACY_NOTICE_VERSION, subjectHash } from './privacy.js';

export async function driverAcknowledged(driver) {
  const { data } = await db().from('consent_current').select('purpose, granted, notice_version')
    .eq('subject_hash', subjectHash(driver.phone)).in('purpose', ['privacy_notice', 'driver_vetting']);
  const ok = (p) => data?.some((c) => c.purpose === p && c.granted && c.notice_version === PRIVACY_NOTICE_VERSION);
  return ok('privacy_notice') && ok('driver_vetting');
}

export const canWork = (driver) => driver.status !== 'suspended';
