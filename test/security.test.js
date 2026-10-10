import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validSignature, newReference } from '../lib/paystack.js';
import { parseBookingRequest, parseQuoteRequest, parseStatusChange, normalPhone } from '../lib/validate.js';

const SECRET = 'sk_test_abc123';
const sign = (body, secret = SECRET) => crypto.createHmac('sha512', secret).update(body).digest('hex');

test('webhook signature: accepts genuine, rejects tampered, wrong key, missing, junk', () => {
  const body = JSON.stringify({ event: 'charge.success', data: { amount: 10000 } });
  const sig = sign(body);
  assert.equal(validSignature(body, sig, SECRET), true);
  assert.equal(validSignature(body.replace('10000', '1'), sig, SECRET), false);
  assert.equal(validSignature(body, sign(body, 'sk_test_other'), SECRET), false);
  assert.equal(validSignature(body, null, SECRET), false);
  assert.equal(validSignature(body, 'not-hex', SECRET), false);
});

test('references are unique and match the verify endpoint pattern', () => {
  assert.notEqual(newReference('SUB'), newReference('SUB'));
  assert.match(newReference('SUB'), /^WZR_SUB_[a-f0-9]{32}$/);
});

const future = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
const good = {
  flight: 'ET 921', arrival_date: future, arrival_time: '14:25',
  airport: 'acc', area: 'Osu', dest_address: 'Oxford Street, near Danquah Circle',
  vehicle: 'sedan', extras: ['meet'], pax: 2, bags: 2,
  passenger_name: 'Ama Owusu', passenger_phone: '024 411 2087', passenger_email: 'ama@example.com',
  confirm_adult: true, privacy_version: '1.0'
};

test('booking: valid request is accepted and normalised', () => {
  const { data, error } = parseBookingRequest(good);
  assert.equal(error, undefined);
  assert.equal(data.flight, 'ET921');
  assert.equal(data.phone, '+233244112087');
  assert.equal(data.area, 'Osu');
  assert.equal(data.airport, 'ACC');
});

test('booking: client cannot set price, distance, zone, status or driver', () => {
  const { data } = parseBookingRequest({ ...good, fare_ghs: 1, distance_m: 1, zone: 'A', status: 'done', driver_id: 'x', pay_method: 'paystack' });
  for (const k of ['fare_ghs', 'distance_m', 'zone', 'status', 'driver_id', 'pay_method']) assert.equal(k in data, false, k);
});

test('booking: email is optional, phone is required', () => {
  assert.ok(parseBookingRequest({ ...good, passenger_email: '' }).data);
  assert.ok(parseBookingRequest({ ...good, passenger_email: 'bad' }).error);
  assert.ok(parseBookingRequest({ ...good, passenger_phone: '' }).error);
});

test('booking: rejects bad inputs', () => {
  const bad = [
    { flight: 'DROP TABLE' }, { arrival_date: '2020-01-01' }, { arrival_time: '25:00' }, { arrival_time: '' },
    { area: '' }, { dest_address: '' },
    { vehicle: 'jet' }, { extras: ['free'] }, { pax: 0 }, { pax: 2.5 }, { bags: -1 }, { vehicle: 'sedan', pax: 4 },
    { passenger_name: 'A' }, { passenger_phone: '123' }
  ];
  for (const b of bad) assert.ok(parseBookingRequest({ ...good, ...b }).error, JSON.stringify(b));
  assert.ok(parseBookingRequest(null).error);
});

test('quote: needs an airport, an area and a vehicle', () => {
  assert.ok(parseQuoteRequest({ airport: 'KMS', area: 'Adum', vehicle: 'van' }).data);
  assert.ok(parseQuoteRequest({ area: 'Adum', vehicle: 'van' }).error);
  assert.ok(parseQuoteRequest({ airport: 'K1', area: 'Adum', vehicle: 'van' }).error);
});

test('one airport per booking: lists and combined codes are rejected', () => {
  for (const airport of [['ACC', 'KMS'], 'ACC,KMS', 'ACCKMS', 'ACC KMS', '', null, 123]) {
    assert.ok(parseQuoteRequest({ airport, area: 'Osu', vehicle: 'sedan' }).error, JSON.stringify(airport));
    assert.ok(parseBookingRequest({ ...good, airport }).error, JSON.stringify(airport));
  }
  assert.equal(parseQuoteRequest({ airport: ' kms ', area: 'Adum', vehicle: 'sedan' }).data.airport, 'KMS');
  assert.ok(parseQuoteRequest({ airport: 'KMS', vehicle: 'van' }).error);
});

test('trip status validation', () => {
  assert.ok(parseStatusChange({ booking_code: 'AKW-7Q3K', to: 'no_show' }).data);
  assert.ok(parseStatusChange({ booking_code: 'akw-7q3k', to: 'met' }).data);
  assert.ok(parseStatusChange({ booking_code: 'AKW-7Q3K', to: 'cancelled' }).error);
  assert.ok(parseStatusChange({ booking_code: "AKW-'; --", to: 'met' }).error);
});

test('phone normalisation', () => {
  assert.equal(normalPhone('0244112087'), '+233244112087');
  assert.equal(normalPhone('+44 7700 900123'), '+447700900123');
  assert.equal(normalPhone('12345'), null);
});
