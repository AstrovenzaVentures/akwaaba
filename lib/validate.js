import { VEHICLES, EXTRAS } from './pricing.js';
import { PRIVACY_NOTICE_VERSION } from './privacy.js';

export const clean = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
export function normalPhone(p) {
  const d = clean(p, 30).replace(/[\s\-()]/g, '');
  if (/^0\d{9}$/.test(d)) return '+233' + d.slice(1);
  if (/^\+\d{10,15}$/.test(d)) return d;
  return null;
}

// Fields shared by a quote and a booking. Only expected fields are read (no mass assignment).
function parseTrip(body) {
  if (!body || typeof body !== 'object') return { error: 'Send the trip details as JSON.' };
  // Exactly one airport code. A list, or text like "ACC,KMS", is rejected rather than cut down to the first code.
  const airport = typeof body.airport === 'string' && /^\s*[A-Za-z]{3}\s*$/.test(body.airport) ? body.airport.trim().toUpperCase() : '';
  const area = clean(body.area, 60);
  const vehicle = clean(body.vehicle, 10);
  const extras = Array.isArray(body.extras) ? [...new Set(body.extras.map((x) => clean(x, 10)))] : [];
  const arrivalTime = clean(body.arrival_time, 5);
  const pax = body.pax === undefined ? 1 : Number(body.pax);
  const bags = body.bags === undefined ? 0 : Number(body.bags);

  if (!/^[A-Z]{3}$/.test(airport)) return { error: 'Choose the airport you are landing at.' };
  if (area.length < 2) return { error: 'Choose your drop-off area from the list.' };
  if (!VEHICLES[vehicle]) return { error: 'Choose a vehicle.' };
  if (!extras.every((x) => EXTRAS[x])) return { error: 'One of the extras is not available.' };
  if (arrivalTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(arrivalTime)) return { error: 'Enter the scheduled arrival time as HH:MM.' };
  if (!Number.isInteger(pax) || pax < 1) return { error: 'Enter the number of passengers.' };
  if (!Number.isInteger(bags) || bags < 0) return { error: 'Enter the number of bags.' };
  if (pax > VEHICLES[vehicle].pax || bags > VEHICLES[vehicle].bags) return { error: 'That vehicle cannot fit this many people or bags.' };
  return { data: { airport, area, vehicle, extras, arrivalTime, pax, bags } };
}

export const parseQuoteRequest = parseTrip;

export function parseBookingRequest(body) {
  const trip = parseTrip(body);
  if (trip.error) return trip;
  const flight = clean(body.flight, 10).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const arrivalDate = clean(body.arrival_date, 10);
  const address = clean(body.dest_address, 200);
  const name = clean(body.passenger_name, 80);
  const phone = normalPhone(body.passenger_phone);
  const email = clean(body.passenger_email, 254).toLowerCase();

  if (!/^[A-Z0-9]{2}\d{1,4}$/.test(flight)) return { error: 'Enter a valid flight number, for example ET921.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(arrivalDate) || Number.isNaN(Date.parse(arrivalDate))) return { error: 'Enter the arrival date.' };
  if (arrivalDate < new Date().toISOString().slice(0, 10)) return { error: 'The arrival date is in the past.' };
  if (!trip.data.arrivalTime) return { error: 'Enter the scheduled arrival time as HH:MM.' };
  if (address.length < 3) return { error: 'Enter your drop-off address or a nearby landmark.' };
  if (name.length < 2) return { error: 'Enter the lead passenger name.' };
  if (!phone) return { error: 'Enter a valid phone number so your driver can reach you.' };
  if (email && !validEmail(email)) return { error: 'Enter a valid email address, or leave it blank.' };
  // Only a real true counts: the box must have been ticked, not merely sent as "yes" or 1.
  if (body.confirm_adult !== true) return { error: 'Please confirm you are 18 or over. Bookings must be made by an adult.' };
  if (body.privacy_version !== PRIVACY_NOTICE_VERSION) return { error: 'Our privacy notice has been updated. Refresh the page, read the notice and book again.' };
  const marketing = body.marketing_opt_in === true;

  return { data: { ...trip.data, flight, arrivalDate, address, name, phone, email: email || null, marketing, privacyVersion: PRIVACY_NOTICE_VERSION } };
}

export const TRIP_FLOW = { assigned: 'waiting', waiting: 'met', met: 'enroute', enroute: 'done' };
// Previous step required for each move. A no-show can only be recorded while the driver is waiting at the airport.
export const FROM_STEP = { waiting: 'assigned', met: 'waiting', enroute: 'met', done: 'enroute', no_show: 'waiting' };

export function parseStatusChange(body) {
  const code = clean(body?.booking_code, 10).toUpperCase();
  const to = clean(body?.to, 10);
  if (!/^AKW-[A-Z0-9]{4}$/.test(code)) return { error: 'Invalid booking code.' };
  if (!FROM_STEP[to]) return { error: 'Invalid trip status.' };
  return { data: { code, to } };
}
