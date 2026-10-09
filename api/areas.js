// GET /api/areas
// Airports and their drop-off areas grouped by zone, for the booking page.
import { loadAirports, loadZones } from '../lib/quote.js';
import { json, handle } from '../lib/http.js';
import { PRIVACY_NOTICE_VERSION } from '../lib/privacy.js';

export async function GET() {
  return handle(async () => {
    const [airports, zones] = await Promise.all([loadAirports(), loadZones()]);
    return json(200, {
      privacy_version: PRIVACY_NOTICE_VERSION,
      airports: airports.map((a) => ({
        code: a.code, name: a.name, city: a.city,
        zones: zones.filter((z) => z.airport === a.code).map((z) => ({ zone: z.zone, label: z.label, areas: z.areas }))
      }))
    });
  });
}
