// GET /api/staff/drivers   Staff only (password + authenticator code).
// Applicants and drivers, newest first, with subscription status and recorded vetting checks.
import { db } from '../../lib/db.js';
import { requireStaff } from '../../lib/auth.js';
import { json, handle } from '../../lib/http.js';

export async function GET(request) {
  return handle(async () => {
    const staff = await requireStaff(request);
    if (!staff) return json(401, { error: 'Staff sign-in with your authenticator code is required.' });

    const { data: drivers, error } = await db().from('drivers')
      .select('id, name, phone, email, vehicle_type, vehicle_model, plate, base_airport, status, sub_until, created_at')
      .order('created_at', { ascending: false }).limit(500);
    if (error) throw new Error('drivers query failed: ' + error.message);

    const { data: checks } = await db().from('driver_vetting').select('driver_id, check_type, result, checked_at')
      .in('driver_id', drivers.map((d) => d.id));
    const now = Date.now();
    return json(200, {
      staff: { email: staff.email, role: staff.role },
      drivers: drivers.map((d) => ({
        ...d,
        subscription_active: !!d.sub_until && new Date(d.sub_until).getTime() > now,
        checks: (checks || []).filter((c) => c.driver_id === d.id).map(({ driver_id, ...c }) => c)
      }))
    });
  });
}
