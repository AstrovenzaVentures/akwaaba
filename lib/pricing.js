// The server is the only place prices are decided. Clients send choices, never amounts.
//
// Money model: travellers pay the driver directly on arrival (cash or mobile money).
// The only payment through Akwaaba is the driver's GHS 100 monthly subscription.

export const SUBSCRIPTION_GHS = 100;
export const SUBSCRIPTION_PESEWAS = SUBSCRIPTION_GHS * 100;
export const SUBSCRIPTION_DAYS = 30;

export const VEHICLES = {
  sedan: { name: 'Sedan', pax: 3, bags: 3, mult: 1 },
  suv: { name: 'SUV', pax: 4, bags: 5, mult: 1.5 },
  van: { name: 'Van', pax: 7, bags: 10, mult: 2.2 }
};

export const EXTRAS = {
  meet: { name: 'Meet inside arrivals hall', ghs: 50 },
  child: { name: 'Child seat', ghs: 40 },
  stop: { name: 'Extra stop on the way', ghs: 60 }
};

export const NIGHT_RATE = 0.2; // arrivals 22:00 to 04:59

const round5 = (n) => Math.round(n / 5) * 5;

export function isNight(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm || '');
  if (!m) return false;
  const h = Number(m[1]);
  return h >= 22 || h < 5;
}

// zones: rows from zone_fares, each { zone, label, areas: [...], sedan_ghs }. Finds the zone that lists the area.
export function zoneForArea(area, zones) {
  const key = String(area || '').trim().toLowerCase();
  if (!key) return null;
  return zones.find((z) => (z.areas || []).some((a) => a.toLowerCase() === key)) || null;
}

// Fare the traveller pays the driver on arrival. Whole cedis, no processing fee.
export function quoteFare({ zoneFareGhs, vehicle, extras = [], arrivalTime }) {
  const v = VEHICLES[vehicle];
  if (!v) throw new Error('Unknown vehicle');
  if (!Number.isInteger(zoneFareGhs) || zoneFareGhs <= 0) throw new Error('Invalid zone fare');

  const lines = [];
  const base = round5(zoneFareGhs * v.mult);
  lines.push({ label: `${v.name} fare`, ghs: base });
  if (isNight(arrivalTime)) lines.push({ label: 'Night arrival', ghs: round5(base * NIGHT_RATE) });
  for (const id of extras) {
    const e = EXTRAS[id];
    if (!e) throw new Error('Unknown extra');
    lines.push({ label: e.name, ghs: e.ghs });
  }
  const totalGhs = lines.reduce((s, l) => s + l.ghs, 0);
  return { lines, totalGhs };
}
