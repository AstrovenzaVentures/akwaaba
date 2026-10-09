import { db } from './db.js';
import { quoteFare, zoneForArea } from './pricing.js';

export async function loadAirports() {
  const { data, error } = await db().from('airports').select('code, name, city, pickup_note').eq('active', true).order('code');
  if (error) throw new Error('airports unavailable');
  return data;
}

export async function loadZones(airport) {
  let q = db().from('zone_fares').select('zone, airport, label, areas, sedan_ghs').order('zone');
  if (airport) q = q.eq('airport', airport);
  const { data, error } = await q;
  if (error) throw new Error('zone_fares unavailable');
  return data;
}

// Finds the zone for the chosen airport and drop-off area, then prices the trip. The browser never sends a price.
export async function priceTrip(trip) {
  const airports = await loadAirports();
  const airport = airports.find((a) => a.code === trip.airport);
  if (!airport) return { error: 'Choose the airport you are landing at.' };
  const zones = await loadZones(airport.code);
  const zone = zoneForArea(trip.area, zones);
  if (!zone) return { error: `Choose your drop-off area from the ${airport.city} list.` };
  const quote = quoteFare({ zoneFareGhs: zone.sedan_ghs, vehicle: trip.vehicle, extras: trip.extras, arrivalTime: trip.arrivalTime });
  return { airport, zone, area: zone.areas.find((a) => a.toLowerCase() === trip.area.toLowerCase()), quote };
}

export function publicQuote({ airport, zone, area, quote }) {
  return {
    airport: airport.code,
    airport_name: airport.name,
    pickup_note: airport.pickup_note,
    area,
    zone: zone.zone,
    zone_label: zone.label,
    lines: quote.lines,
    total_ghs: quote.totalGhs,
    payment: 'Pay your driver on arrival, in cash or mobile money.'
  };
}
