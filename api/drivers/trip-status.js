// POST /api/drivers/trip-status   body: { "booking_code": "AKW-XXXX", "to": "waiting" | "met" | "enroute" | "done" | "no_show" }
// Moves the driver's own trip one step forward. Steps cannot be skipped or reversed.
// "no_show" is allowed only from "waiting" and only once the free waiting time after landing has passed.
import { db } from '../../lib/db.js';
import { requireDriver } from '../../lib/auth.js';
import { parseStatusChange, FROM_STEP } from '../../lib/validate.js';
import { json, handle, readJson } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const driver = await requireDriver(request);
    if (!driver) return json(401, { error: 'Sign in as a driver.' });

    const { data: c, error } = parseStatusChange(await readJson(request));
    if (error) return json(400, { error });

    const from = FROM_STEP[c.to];

    if (c.to === 'no_show') {
      const { data: t } = await db().from('bookings').select('arrival_date, arrival_time, flight')
        .eq('code', c.code).eq('driver_id', driver.id).maybeSingle();
      if (!t) return json(409, { error: 'This trip cannot move to that step. Refresh your trips.' });
      // Free waiting: 60 minutes after landing. Arrival times are Ghana time (GMT, no daylight saving).
      const landed = new Date(`${t.arrival_date}T${t.arrival_time}:00Z`);
      if (Date.now() < landed.getTime() + 60 * 60 * 1000) {
        return json(409, { error: 'You can mark a no-show only after 60 minutes of free waiting from the scheduled landing time.' });
      }
    }
    // Conditional update: only this driver's trip, only from the expected previous step.
    const { data: updated } = await db().from('bookings')
      .update({ status: c.to, [`${c.to === 'no_show' ? 'done' : c.to}_at`]: new Date().toISOString() })
      .eq('code', c.code).eq('driver_id', driver.id).eq('status', from)
      .select('code, status').maybeSingle();

    if (!updated) return json(409, { error: 'This trip cannot move to that step. Refresh your trips.' });
    if (c.to === 'no_show') {
      // Kept 12 months as a hash of the phone number only (privacy policy section 9), to spot repeated no-shows.
      const { data: h } = await db().from('bookings').select('passenger_phone_hash').eq('code', c.code).maybeSingle();
      if (h?.passenger_phone_hash) await db().from('abuse_flags').insert({ subject_hash: h.passenger_phone_hash, reason: 'no_show', booking_code: c.code });
    }
    return json(200, updated);
  });
}
