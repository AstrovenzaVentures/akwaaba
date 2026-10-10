// Direct MoMo/bank payments: driver claim with screenshot, staff confirmation, against a stand-in database and storage.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.PII_INDEX_KEY = crypto.randomBytes(32).toString('base64');
process.env.PII_ENC_KEYS = 'v1:' + crypto.randomBytes(32).toString('base64');

const T = {};
const reset = () => Object.assign(T, {
  payment_accounts: [
    { method: 'mtn', label: 'MTN MoMo', account_name: 'ASTROVENZA VENTURES', account_number: '0240000000', active: true, sort: 1 },
    { method: 'telecel', label: 'Telecel Cash', account_name: 'ASTROVENZA VENTURES', account_number: 'FILL IN', active: true, sort: 2 },
    { method: 'bank', label: 'Bank transfer', account_name: 'ASTROVENZA VENTURES', account_number: '1234567890', bank_name: 'GCB', branch: 'FILL IN', active: true, sort: 4 },
    { method: 'airteltigo', label: 'AirtelTigo Money', account_name: 'ASTROVENZA VENTURES', account_number: '0270000000', active: false, sort: 3 }
  ],
  payments: [], audit_log: [], bookings: [], consent_current: [], drivers: [], driver_vetting: []
});
reset();
const storage = { uploads: [], removed: [] };
const rpcCalls = [];
let rpcResult = 'subscription_extended';

function from(table) {
  const f = {}; const neq = {};
  const rows = () => (T[table] || []).filter((r) => Object.entries(f).every(([k, v]) => r[k] === v) && Object.entries(neq).every(([k, v]) => r[k] !== v));
  const b = {
    select() { return b; }, order() { return b; }, limit() { return b; }, in() { return b; }, gte() { return b; }, not() { return b; }, lt() { return Promise.resolve({ data: [] }); },
    eq(k, v) { f[k] = v; return b; }, neq(k, v) { neq[k] = v; return b; },
    insert(p) {
      const list = Array.isArray(p) ? p : [p];
      if (table === 'payments') {
        for (const r of list) {
          if (T.payments.some((x) => x.method === r.method && x.manual_txn_id?.toUpperCase() === r.manual_txn_id?.toUpperCase() && x.status !== 'rejected')) {
            return Promise.resolve({ error: { code: '23505', message: 'duplicate key value violates unique constraint "payments_manual_txn_uniq"' } });
          }
        }
      }
      T[table].push(...list.map((r) => ({ created_at: new Date().toISOString(), ...r })));
      return Promise.resolve({ error: null });
    },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(ok) { ok({ data: rows(), error: null }); }
  };
  return b;
}
const fakeDb = {
  from,
  auth: { admin: { getUserById: async (id) => ({ data: { user: { email: id === 's1' ? 'astrovenzav@gmail.com' : 'x@y.z' } } }) } },
  rpc: async (name, args) => { rpcCalls.push({ name, args }); return { data: rpcResult, error: null }; },
  storage: { from: () => ({
    upload: async (path, buf, opts) => { storage.uploads.push({ path, bytes: buf.length, type: opts.contentType }); return { error: null }; },
    remove: async (paths) => { storage.removed.push(...paths); return { error: null }; },
    createSignedUrl: async (path, secs) => ({ data: { signedUrl: `https://x.supabase.co/sign/${path}?ttl=${secs}` } })
  }) }
};

let driver, staff = null;
mock.module('../lib/db.js', { namedExports: { db: () => fakeDb } });
mock.module('../lib/auth.js', { namedExports: { requireDriver: async () => driver, requireStaff: async () => staff, signedInUser: async () => null } });

const { parseClaim, activeAccounts } = await import('../lib/manual-payment.js');
const { POST: pay } = await import('../api/subscriptions/initialize.js');
const { GET: staffList, POST: staffPost } = await import('../api/staff/drivers.js');
const { GET: trips } = await import('../api/drivers/trips.js');

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(400)]);
const proof = { type: 'image/png', data: png.toString('base64') };
const claim = { method: 'mtn', txn_id: '12345678901', payer_account: '024 411 2087', proof };
const req = (body) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const freshDriver = () => ({ id: 'd1', name: 'Kwame', phone: '+233244112087', plate: 'GR 1', status: 'approved', sub_until: null });

test('drivers only see accounts that are switched on and fully filled in', async () => {
  const list = await activeAccounts();
  assert.deepEqual(list.map((a) => a.method), ['mtn']);   // telecel and bank still say FILL IN; airteltigo is off
});

test('a claim needs an active method, a real transaction ID, the payer and a real picture', async () => {
  const accounts = await activeAccounts();
  assert.match(parseClaim({ ...claim, method: 'telecel' }, accounts).error, /how you paid/);
  assert.match(parseClaim({ ...claim, txn_id: 'ab' }, accounts).error, /transaction ID/);
  assert.match(parseClaim({ ...claim, payer_account: '' }, accounts).error, /paid from/);
  assert.match(parseClaim({ ...claim, proof: { type: 'image/png', data: Buffer.from('<html>' + 'x'.repeat(200)).toString('base64') } }, accounts).error, /not a readable picture/);
  assert.match(parseClaim({ ...claim, proof: { type: 'application/pdf', data: proof.data } }, accounts).error, /screenshot/);
  const ok = parseClaim(claim, accounts);
  assert.equal(ok.method, 'mtn'); assert.equal(ok.txnId, '12345678901'); assert.equal(ok.proof.ext, 'png');
});

test('only an approved driver can send a direct payment', async () => {
  driver = { ...freshDriver(), status: 'pending_review' };
  assert.equal((await pay(req(claim))).status, 403);
  driver = null;
  assert.equal((await pay(req(claim))).status, 401);
});

test('a direct payment stores the screenshot privately and waits for staff; it does not switch anything on', async () => {
  reset(); storage.uploads.length = 0; driver = freshDriver();
  const res = await pay(req(claim));
  assert.equal(res.status, 200);
  const p = T.payments[0];
  assert.equal(p.status, 'submitted'); assert.equal(p.method, 'mtn'); assert.equal(p.amount_pesewas, 10000);
  assert.match(p.reference, /^AKW_MAN_[0-9a-f]{32}$/);
  assert.equal(storage.uploads[0].path, `d1/${p.reference}.png`);
  assert.equal(driver.sub_until, null);
  assert.ok(T.audit_log.some((a) => a.action === 'manual_payment_submitted'));
});

test('a second claim while one is open, or a reused transaction ID, is refused', async () => {
  driver = freshDriver();
  const again = await pay(req({ ...claim, txn_id: '99999999' }));
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /still being checked/);

  T.payments[0].status = 'success';
  storage.removed.length = 0;
  const reuse = await pay(req({ ...claim, txn_id: '12345678901'.toLowerCase() }));
  assert.equal(reuse.status, 409);
  assert.match((await reuse.json()).error, /already been used/);
  assert.equal(storage.removed.length, 1, 'uploaded screenshot is removed when the claim is refused');
});

test('Paystack checkout still works when no method is sent', async () => {
  // No body -> Paystack path; it fails here only because no Paystack key is set in tests.
  driver = freshDriver();
  const res = await pay(new Request('http://x/api', { method: 'POST' }));
  assert.equal(res.status, 500);
  assert.ok(!T.payments.some((p) => p.status === 'submitted' && p.method === 'paystack'));
});

test('staff see open claims with a short-lived private link to the screenshot', async () => {
  reset(); driver = freshDriver(); await pay(req(claim));
  staff = null;
  assert.equal((await staffList(new Request('http://x/api'))).status, 401);
  staff = { user_id: 's1', role: 'admin', email: 'astrovenzav@gmail.com' };
  T.drivers = [{ id: 'd1', name: 'Kwame', phone: '+233244112087', plate: 'GR 1', status: 'approved' }];
  const out = await (await staffList(new Request('http://x/api'))).json();
  assert.equal(out.payments.length, 1);
  assert.equal(out.payments[0].driver_name, 'Kwame');
  assert.match(out.payments[0].proof_url, /ttl=600$/);
  assert.equal(out.payments[0].proof_path, undefined, 'storage path is not sent to the browser');
});

test('staff confirm or reject; a rejection needs a reason; both are logged', async () => {
  const ref = T.payments[0].reference;
  staff = null;
  assert.equal((await staffPost(req({ payment_reference: ref, action: 'confirm_payment' }))).status, 401);
  staff = { user_id: 's1', role: 'admin', email: 'astrovenzav@gmail.com' };
  assert.equal((await staffPost(req({ payment_reference: 'AKW_SUB_x', action: 'confirm_payment' }))).status, 400);
  assert.equal((await staffPost(req({ payment_reference: ref, action: 'reject_payment', note: '' }))).status, 400);

  rpcCalls.length = 0; rpcResult = 'subscription_extended';
  assert.equal((await staffPost(req({ payment_reference: ref, action: 'confirm_payment' }))).status, 200);
  assert.deepEqual(rpcCalls[0], { name: 'review_manual_payment', args: { p_reference: ref, p_staff: 's1', p_approve: true, p_reason: null, p_sub_days: 30 } });
  assert.ok(T.audit_log.some((a) => a.action === 'manual_payment_confirmed' && a.target === ref));

  rpcResult = 'already_handled';
  assert.equal((await staffPost(req({ payment_reference: ref, action: 'reject_payment', note: 'Not on statement' }))).status, 409);
});

test('the driver app gets the accounts and the latest claim; unapproved drivers get no accounts', async () => {
  driver = freshDriver();
  let out = await (await trips(new Request('http://x/api'))).json();
  assert.deepEqual(out.payment.accounts.map((a) => a.method), ['mtn']);
  assert.equal(out.payment.last_claim.status, 'submitted');
  driver = { ...freshDriver(), status: 'pending_review' };
  out = await (await trips(new Request('http://x/api'))).json();
  assert.deepEqual(out.payment.accounts, []);
});

test('staff see each driver\'s payment history with who confirmed it', async () => {
  reset();
  staff = { user_id: 's1', role: 'admin', email: 'astrovenzav@gmail.com' };
  T.drivers = [{ id: 'd1', name: 'Kwame', phone: '+233244112087', plate: 'GR 1', status: 'approved', sub_until: null }];
  T.payments.push(
    { reference: 'AKW_MAN_1', driver_id: 'd1', method: 'mtn', status: 'success', amount_pesewas: 10000, paid_at: '2026-10-01T10:00:00Z', created_at: '2026-10-01T09:00:00Z', reviewed_by: 's1', reviewed_at: '2026-10-01T10:00:00Z', manual_txn_id: 'TX1' },
    { reference: 'AKW_SUB_2', driver_id: 'd1', method: 'paystack', status: 'success', amount_pesewas: 10000, paid_at: '2026-09-01T10:00:00Z', created_at: '2026-09-01T10:00:00Z' });
  const out = await (await staffList(new Request('http://x/api'))).json();
  const hist = out.drivers[0].payments;
  assert.equal(hist.length, 2);
  assert.equal(hist.find((h) => h.method === 'mtn').reviewed_by, 'astrovenzav@gmail.com');
  assert.equal(hist.find((h) => h.method === 'paystack').reviewed_by, null);
  assert.equal(hist[0].driver_id, undefined);
});
