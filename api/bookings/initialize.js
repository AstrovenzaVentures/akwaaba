// POST /api/bookings/initialize
// Prices the trip, reserves a driver and confirms the booking. No payment is taken: the traveller pays the driver on arrival.
// Traveller name, phone, email and address are encrypted here, before they reach the database.
import { db } from '../../lib/db.js';
import { parseBookingRequest } from '../../lib/validate.js';
import { priceTrip, publicQuote } from '../../lib/quote.js';
import { protectBooking } from '../../lib/privacy.js';
import { json, handle, readJson } from '../../lib/http.js';

export async function POST(request) {
  return handle(async () => {
    const { data: b, error } = parseBookingRequest(await readJson(request));
    if (error) return json(400, { error });

    const priced = await priceTrip(b);
    if (priced.error) return json(422, { error: priced.error });
    const { airport, zone, area, quote } = priced;
    const protectedFields = protectBooking(b);

    // One database transaction: picks a free, approved driver with an active subscription, inserts the booking,
    // and records marketing consent if the traveller ticked the box.
    const { data: created, error: rpcErr } = await db().rpc('create_booking', {
      p: {
        airport: airport.code, flight: b.flight, arrival_date: b.arrivalDate, arrival_time: b.arrivalTime,
        area, zone: zone.zone, vehicle: b.vehicle, extras: b.extras, pax: b.pax, bags: b.bags,
        ...protectedFields,
        privacy_notice_version: b.privacyVersion, marketing: b.marketing,
        fare_ghs: quote.totalGhs, fare_lines: quote.lines
      }
    });
    if (rpcErr) {
      if (/other_airport/.test(rpcErr.message)) {
        // Kept 12 months as a hash only (privacy policy section 9), to spot repeated duplicate bookings.
        await db().from('abuse_flags').insert({ subject_hash: protectedFields.passenger_phone_hash, reason: 'other_airport_block' });
        return json(409, { error: 'You already have a pickup booked at the other airport around this time. You can book one airport at a time. Contact astrovenzav@gmail.com to change your booking.' });
      }
      if (/too_many_bookings/.test(rpcErr.message)) {
        return json(409, { error: 'This phone number already has two upcoming pickups. Contact astrovenzav@gmail.com if you need another.' });
      }
      if (/too_far_ahead/.test(rpcErr.message)) return json(400, { error: 'You can book up to 90 days ahead.' });
      if (/no_driver/.test(rpcErr.message)) {
        return json(409, { error: `No driver is available at ${airport.name} for that time and vehicle. Try another vehicle size or time.` });
      }
      throw new Error('create_booking failed: ' + rpcErr.message);
    }
    const booking = Array.isArray(created) ? created[0] : created;

    return json(200, {
      booking_code: booking.code,
      status: 'assigned',
      // The traveller sends their exact drop-off location to this WhatsApp number after booking.
      driver: { name: booking.driver_name, vehicle: booking.vehicle_model, plate: booking.plate, phone: booking.driver_phone },
      fare: publicQuote(priced)
    });
  });
}
