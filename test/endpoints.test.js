// Runs the booking, driver trips and driver consent endpoints against a stand-in database,
// to check what actually leaves the server: no plain-text traveller details, consent recorded correctly.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PII_ENC_KEYS = 'v1:' + crypto.randomBytes(32).toString('base64');
process.env.PII_INDEX_KEY = crypto.randomBytes(32).toString('base64');

const state = { tables: {}, calls: [], rpc: null };
function from(table) {
  const q = { table, filters: {} };
  const rows = () => (state.tables[table] || []).filter((r) => Object.entries(q.filters).every(([k, v]) => r[k] === undefined || r[k] === v));
  const b = {
    select() { return b; }, in() { return b; }, gte() { return b; }, order() { return b; },
    eq(k, v) { q.filters[k] = v; return b; },
    insert(payload) { state.calls.push({ table, op: 'insert', payload }); return Promise.resolve({ error: null }); },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(ok) { ok({ data: rows(), error: null }); }
  };
  return b;
}
const fakeDb = { from, rpc: async (name, args) => { state.calls.push({ rpc: name, args }); return state.rpc(args); } };
const driver = { id: 'd1', name: 'Kwame', phone: '+233200000001', plate: 'GR 1', vehicle_type: 'sedan', base_airport: 'ACC', status: 'approved', sub_until: new Date(Date.now() + 864e5).toISOString() };

mock.module('../lib/db.js', { namedExports: { db: () => fakeDb } });
mock.module('../lib/auth.js', { namedExports: { requireDriver: async () => driver, requireStaff: async () => null } });

const { POST: book } = await import('../api/bookings/initialize.js');
const { GET: trips } = await import('../api/drivers/trips.js');
const { POST: consent } = await import('../api/drivers/trips.js');
const { encryptField, blindIndex } = await import('../lib/pii-crypto.js');

const future = new Date(Date.now() + 5 * 864e5).toISOString().slice(0, 10);
const req = (body) => new Request('http://x/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const booking = {
  flight: 'ET921', arrival_date: future, arrival_time: '14:25', airport: 'ACC', area: 'Osu', dest_address: 'Oxford Street',
  vehicle: 'sedan', extras: [], pax: 2, bags: 2, passenger_name: 'Ama Owusu', passenger_phone: '0244112087',
  passenger_email: 'ama@example.com', confirm_adult: true, privacy_version: '1.0', marketing_opt_in: true
};
state.tables.airports = [{ code: 'ACC', name: 'Kotoka International Airport', city: 'Accra', pickup_note: 'Exit 2' }];
state.tables.zone_fares = [{ zone: 'ACC-B', airport: 'ACC', label: 'Zone B', areas: ['Osu'], sedan_ghs: 220 }];

test('booking: only ciphertext and a hash are sent to the database, with the marketing choice', async () => {
  state.calls = [];
  state.rpc = async () => ({ data: [{ id: 'b1', code: 'AKW-AB12', driver_name: 'Kwame', driver_phone: '+233200000001', vehicle_model: 'Corolla', plate: 'GR 1' }], error: null });
  const res = await book(req(booking));
  assert.equal(res.status, 200);
  const { args } = state.calls.find((c) => c.rpc === 'create_booking');
  const sent = JSON.stringify(args);
  for (const plain of ['Ama Owusu', '244112087', 'ama@example.com', 'Oxford Street']) assert.ok(!sent.includes(plain), plain);
  assert.equal(args.p.passenger_phone_hash, blindIndex('+233244112087'));
  assert.equal(args.p.marketing, true);
  assert.equal(args.p.privacy_notice_version, '1.0');
});

test('booking: unticked 18+ box is refused before anything is stored', async () => {
  state.calls = [];
  const res = await book(req({ ...booking, confirm_adult: false }));
  assert.equal(res.status, 400);
  assert.equal(state.calls.length, 0);
});

test('booking: a blocked second-airport booking leaves only a hashed abuse flag', async () => {
  state.calls = [];
  state.rpc = async () => ({ data: null, error: { message: 'other_airport' } });
  const res = await book(req(booking));
  assert.equal(res.status, 409);
  const flag = state.calls.find((c) => c.table === 'abuse_flags');
  assert.deepEqual(flag.payload, { subject_hash: blindIndex('+233244112087'), reason: 'other_airport_block' });
});

test('driver trips: passenger details decrypted for the driver; acknowledgement status reported', async () => {
  state.tables.bookings = [{
    code: 'AKW-AB12', airport: 'ACC', status: 'assigned', fare_ghs: 220,
    passenger_name_enc: encryptField('Ama Owusu', 'bookings.passenger_name'),
    passenger_phone_enc: encryptField('+233244112087', 'bookings.passenger_phone'),
    dest_address_enc: encryptField('Oxford Street', 'bookings.dest_address')
  }];
  state.tables.consent_current = [];
  let out = await (await trips(new Request('http://x/api'))).json();
  assert.equal(out.trips[0].passenger_name, 'Ama Owusu');
  assert.equal(out.trips[0].passenger_phone, '+233244112087');
  assert.ok(!JSON.stringify(out).includes('v1:'), 'no ciphertext sent to the browser');
  assert.equal(out.privacy.acknowledged, false);

  const h = blindIndex(driver.phone);
  state.tables.consent_current = [
    { subject_hash: h, purpose: 'privacy_notice', granted: true, notice_version: '1.0' },
    { subject_hash: h, purpose: 'driver_vetting', granted: true, notice_version: '1.0' }
  ];
  out = await (await trips(new Request('http://x/api'))).json();
  assert.equal(out.privacy.acknowledged, true);
});

test('driver consent: both required boxes needed; marketing no is recorded only when withdrawing a yes', async () => {
  state.calls = [];
  assert.equal((await consent(req({ privacy_version: '1.0', privacy_notice: true, vetting: false }))).status, 400);
  assert.equal(state.calls.length, 0);

  state.tables.consent_current = [];
  await consent(req({ privacy_version: '1.0', privacy_notice: true, vetting: true, marketing: false }));
  let rows = state.calls.at(-1).payload;
  assert.deepEqual(rows.map((r) => r.purpose), ['privacy_notice', 'driver_vetting']);
  assert.ok(rows.every((r) => r.subject_hash === blindIndex(driver.phone) && r.subject_type === 'driver'));

  state.tables.consent_current = [{ subject_hash: blindIndex(driver.phone), purpose: 'marketing', granted: true }];
  await consent(req({ privacy_version: '1.0', privacy_notice: true, vetting: true, marketing: false }));
  rows = state.calls.at(-1).payload;
  assert.deepEqual(rows.at(-1), { ...rows[0], purpose: 'marketing', granted: false });
});
