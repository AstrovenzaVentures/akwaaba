// GET /api/drivers/trips: the driver's own pickups.
// POST /api/drivers/trips: { privacy_version, privacy_notice: true, vetting: true, marketing } records the driver's
// privacy acknowledgement and written consent to vetting (Act 843 s.37) in the append-only consent ledger.
// The signed-in driver's own trips (never anyone else's). Passenger details are decrypted here, on the server,
// only for this driver's trips. Keys and ciphertext never reach the browser.
import { db } from '../../lib/db.js';
import { requireDriver } from '../../lib/auth.js';
import { decryptField } from '../../lib/pii-crypto.js';
import { PRIVACY_NOTICE_VERSION, subjectHash } from '../../lib/privacy.js';
import { json, handle, readJson } from '../../lib/http.js';

const open = (row, col) => decryptField(row[`${col}_enc`], `bookings.${col}`);

export async function GET(request) {
  return handle(async () => {
    const driver = await requireDriver(request);
    if (!driver) return json(401, { error: 'Sign in as a driver.' });

    const since = new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10);
    const { data: rows, error } = await db().from('bookings')
      .select('code, airport, flight, arrival_date, arrival_time, area, vehicle, extras, pax, bags, fare_ghs, status, passenger_name_enc, passenger_phone_enc, dest_address_enc')
      .eq('driver_id', driver.id)
      .in('status', ['assigned', 'waiting', 'met', 'enroute', 'done', 'no_show'])
      .gte('arrival_date', since)
      .order('arrival_date').order('arrival_time');
    if (error) throw new Error('trips query failed: ' + error.message);

    const trips = rows.map(({ passenger_name_enc, passenger_phone_enc, dest_address_enc, ...t }) => {
      const r = { passenger_name_enc, passenger_phone_enc, dest_address_enc };
      return { ...t, passenger_name: open(r, 'passenger_name'), passenger_phone: open(r, 'passenger_phone'), dest_address: open(r, 'dest_address') };
    });

    // Has this driver acknowledged the current privacy notice and agreed to vetting checks?
    const { data: consents } = await db().from('consent_current').select('purpose, granted, notice_version')
      .eq('subject_hash', subjectHash(driver.phone)).in('purpose', ['privacy_notice', 'driver_vetting']);
    const ok = (purpose) => consents?.some((c) => c.purpose === purpose && c.granted && c.notice_version === PRIVACY_NOTICE_VERSION);

    const subActive = driver.sub_until && new Date(driver.sub_until) > new Date();
    return json(200, {
      driver: {
        name: driver.name, plate: driver.plate, vehicle: driver.vehicle_type, base_airport: driver.base_airport, status: driver.status,
        subscription_active: !!subActive, sub_until: driver.sub_until
      },
      privacy: { version: PRIVACY_NOTICE_VERSION, acknowledged: ok('privacy_notice') && ok('driver_vetting') },
      trips
    });
  });
}

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
