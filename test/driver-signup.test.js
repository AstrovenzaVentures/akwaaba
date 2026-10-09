// Driver application and staff approval endpoints, against a stand-in database.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PII_INDEX_KEY = crypto.randomBytes(32).toString('base64');
process.env.PII_ENC_KEYS = 'v1:' + crypto.randomBytes(32).toString('base64');

const T = { drivers: [], airports: [{ code: 'ACC', active: true }, { code: 'KMS', active: true }], consent_events: [], driver_vetting: [], audit_log: [] };
let nextId = 1;
function from(table) {
  const f = {}; let op = 'select'; let patch;
  const rows = () => (T[table] || []).filter((r) => Object.entries(f).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)));
  const b = {
    select() { return b; }, order() { return b; }, limit() { return b; },
    eq(k, v) { f[k] = v; return b; }, in(k, v) { f[k] = v; return b; },
    insert(p) {
      const list = Array.isArray(p) ? p : [p];
      for (const r of list) {
        if (table === 'drivers' && T.drivers.some((d) => d.phone === r.phone)) return Promise.resolve({ error: { message: 'duplicate key drivers_phone_key' } });
        if (table === 'drivers' && T.drivers.some((d) => d.plate === r.plate)) return Promise.resolve({ error: { message: 'duplicate key drivers_plate_key' } });
      }
      T[table].push(...list.map((r) => ({ id: r.id || nextId++, created_at: new Date().toISOString(), ...r })));
      return Promise.resolve({ error: null });
    },
    update(p) { op = 'update'; patch = p; return b; },
    maybeSingle() {
      const r = rows();
      if (op === 'update') r.forEach((x) => Object.assign(x, patch));
      return Promise.resolve({ data: r[0] || null, error: null });
    },
    then(ok) { ok({ data: rows(), error: null }); }
  };
  return b;
}
let user = null, staff = null;
mock.module('../lib/db.js', { namedExports: { db: () => ({ from }) } });
mock.module('../lib/auth.js', { namedExports: { signedInUser: async () => user, requireDriver: async () => null, requireStaff: async () => staff } });

const { POST: apply } = await import('../api/drivers/apply.js');
const { POST: setStatus } = await import('../api/staff/driver-status.js');
const { GET: list } = await import('../api/staff/drivers.js');
const req = (body) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const ALL = ['ghana_card', 'drivers_licence', 'dvla_ride_hailing', 'police_clearance', 'vehicle_roadworthy'];
const form = { name: 'Kwame Mensah', phone: '024 411 2087', vehicle_type: 'sedan', vehicle_model: 'Toyota Corolla', plate: 'gr 4521-22',
  base_airport: 'KMS', adult: true, privacy_notice: true, vetting: true, privacy_version: '1.0' };
const uid = '11111111-1111-1111-1111-111111111111';

test('application needs a confirmed email session', async () => {
  user = null;
  assert.equal((await apply(req(form))).status, 401);
});

test('application is validated and refused without the required consents', async () => {
  user = { id: uid, email: 'Kwame@Gmail.com' };
  for (const bad of [{ name: 'Kwame' }, { phone: '123' }, { vehicle_type: 'bus' }, { plate: '!!' }, { base_airport: 'XXX' }, { vetting: false }, { adult: false }, { privacy_version: '0.9' }]) {
    assert.equal((await apply(req({ ...form, ...bad }))).status, 400, JSON.stringify(bad));
  }
  assert.equal(T.drivers.length, 0);
});

test('a valid application creates a pending driver and records written consent', async () => {
  const res = await apply(req(form));
  assert.equal(res.status, 200);
  const d = T.drivers[0];
  assert.equal(d.status, 'pending_review');
  assert.equal(d.phone, '+233244112087');
  assert.equal(d.plate, 'GR 4521-22');
  assert.equal(d.email, 'kwame@gmail.com');
  assert.equal(d.base_airport, 'KMS');
  assert.deepEqual(T.consent_events.map((c) => c.purpose), ['privacy_notice', 'driver_vetting']);
  assert.ok(T.consent_events.every((c) => !JSON.stringify(c).includes('244112087')), 'consent ledger holds a hash, not the number');
});

test('applying twice, or with someone else\'s phone or plate, is refused', async () => {
  assert.equal((await apply(req(form))).status, 409);
  user = { id: '22222222-2222-2222-2222-222222222222', email: 'ama@gmail.com' };
  assert.equal((await apply(req({ ...form, plate: 'AS 1-24' }))).status, 409, 'same phone');
  assert.equal((await apply(req({ ...form, phone: '0201234567' }))).status, 409, 'same plate');
});

test('only signed-in staff (aal2) can list or approve', async () => {
  staff = null;
  assert.equal((await list(new Request('http://x'))).status, 401);
  assert.equal((await setStatus(req({ driver_id: uid, action: 'approve', checks: ALL }))).status, 401);
});

test('approval requires all five checks, records them, and moves the driver to approved', async () => {
  staff = { user_id: '99999999-9999-9999-9999-999999999999', role: 'admin', email: 'astrovenzav@gmail.com' };
  assert.equal((await setStatus(req({ driver_id: uid, action: 'approve', checks: ALL.slice(0, 4) }))).status, 400);
  assert.equal(T.drivers[0].status, 'pending_review');
  const res = await setStatus(req({ driver_id: uid, action: 'approve', checks: ALL }));
  assert.equal(res.status, 200);
  assert.equal(T.drivers[0].status, 'approved');
  assert.equal(T.driver_vetting.length, 5);
  assert.ok(T.driver_vetting.every((v) => v.result === 'pass' && v.provider === 'staff_visual_check' && v.consent_event_id && v.checked_by === staff.user_id));
  assert.ok(T.audit_log.some((a) => a.action === 'driver_approve' && a.actor === staff.user_id));
});

test('approving twice is refused; suspend and reinstate work and are logged', async () => {
  assert.equal((await setStatus(req({ driver_id: uid, action: 'approve', checks: ALL }))).status, 409);
  assert.equal((await setStatus(req({ driver_id: uid, action: 'suspend', note: 'Licence expired' }))).status, 200);
  assert.equal(T.drivers[0].status, 'suspended');
  assert.equal((await setStatus(req({ driver_id: uid, action: 'reinstate' }))).status, 200);
  assert.equal(T.drivers[0].status, 'approved');
  assert.ok(T.audit_log.some((a) => a.action === 'driver_suspend' && a.detail?.note === 'Licence expired'));
});

test('staff list shows drivers with their recorded checks', async () => {
  const out = await (await list(new Request('http://x'))).json();
  assert.equal(out.drivers.length, 1);
  assert.equal(out.drivers[0].checks.length, 5);
});
