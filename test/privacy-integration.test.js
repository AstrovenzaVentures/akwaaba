import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseBookingRequest } from '../lib/validate.js';
import { PRIVACY_NOTICE_VERSION, protectBooking, subjectHash } from '../lib/privacy.js';
import { decryptField } from '../lib/pii-crypto.js';
import { renderPolicySource } from '../scripts/policy-source.mjs';

process.env.PII_ENC_KEYS = 'v1:' + crypto.randomBytes(32).toString('base64');
process.env.PII_INDEX_KEY = crypto.randomBytes(32).toString('base64');

const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const good = {
  flight: 'ET921', arrival_date: future, arrival_time: '14:25', airport: 'ACC', area: 'Osu', dest_address: 'Oxford Street',
  vehicle: 'sedan', extras: [], pax: 2, bags: 2, passenger_name: 'Ama Owusu', passenger_phone: '0244112087',
  confirm_adult: true, privacy_version: PRIVACY_NOTICE_VERSION
};
const policy = fs.readFileSync(new URL('../docs/privacy-policy.md', import.meta.url), 'utf8');

test('policy file version matches the version the app records', () => {
  assert.equal(/\*\*Version:\*\*\s*([\d.]+)/.exec(policy)[1], PRIVACY_NOTICE_VERSION);
});

test('booking needs the 18+ box ticked: only a real true counts', () => {
  for (const v of [undefined, false, 'true', 1, 'yes']) {
    assert.ok(parseBookingRequest({ ...good, confirm_adult: v }).error, String(v));
  }
  assert.ok(parseBookingRequest(good).data);
});

test('booking from a page showing an old privacy notice is refused', () => {
  assert.match(parseBookingRequest({ ...good, privacy_version: '0.9' }).error, /privacy notice/);
  assert.ok(parseBookingRequest({ ...good, privacy_version: undefined }).error);
});

test('bookings more than 90 days ahead are refused', () => {
  const far = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
  assert.match(parseBookingRequest({ ...good, arrival_date: far }).error, /90 days/);
});

test('marketing is off unless the box was ticked', () => {
  assert.equal(parseBookingRequest(good).data.marketing, false);
  assert.equal(parseBookingRequest({ ...good, marketing_opt_in: 'on' }).data.marketing, false);
  assert.equal(parseBookingRequest({ ...good, marketing_opt_in: true }).data.marketing, true);
});

test('traveller details are stored encrypted, bound to their column, with a matching hash', () => {
  const b = parseBookingRequest(good).data;
  const enc = protectBooking(b);
  const all = JSON.stringify(enc);
  for (const plain of ['Ama Owusu', '+233244112087', 'Oxford Street']) assert.ok(!all.includes(plain), plain);
  assert.equal(decryptField(enc.passenger_phone_enc, 'bookings.passenger_phone'), '+233244112087');
  assert.throws(() => decryptField(enc.passenger_phone_enc, 'bookings.passenger_name'));
  assert.equal(enc.passenger_email_enc, null, 'no email given, nothing stored');
  assert.equal(enc.passenger_phone_hash, subjectHash('+233244112087'));
});

test('published policy: optional clauses follow the feature switches', () => {
  const off = renderPolicySource(policy, { encryption: true });
  assert.ok(!/▣|Before publishing/.test(off));
  assert.ok(!/Live trip location|Masked calls|Flight tracking/.test(off), 'unbuilt features are not described');
  assert.match(off, /Woezor Rides does not track the location/);
  assert.match(off, /additional encryption of travellers/);

  const gps = renderPolicySource(policy, { encryption: true, gps: true });
  assert.match(gps, /Live trip location/);
  assert.match(gps, /Detailed trip location points/);
  assert.ok(!/Woezor Rides does not track the location/.test(gps), 'the "no location" statement goes when location is live');
  assert.match(gps, /Booking and contact and location data/);
});

test('pages load nothing from third parties', () => {
  for (const f of ['index.html', 'driver.html', 'payment-complete.html']) {
    const html = fs.readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
    assert.ok(!/(src|href)="https?:\/\//.test(html), f);
    assert.match(html, /href="\/privacy"/, `${f} links to the privacy policy`);
  }
  const csp = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
    .headers[0].headers.find((h) => h.key === 'Content-Security-Policy').value;
  assert.ok(!/jsdelivr|googleapis|gstatic/.test(csp));
});
