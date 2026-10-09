import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GET, isSecretKey } from '../api/config.js';

const jwt = (role) => 'x.' + Buffer.from(JSON.stringify({ role })).toString('base64url') + '.y';

test('a secret or service-role key is never sent to browsers', async () => {
  for (const k of ['sb_secret_abc123', jwt('service_role')]) {
    process.env.SUPABASE_ANON_KEY = k;
    const res = GET();
    assert.equal(res.status, 500);
    assert.ok(!(await res.text()).includes(k));
  }
  assert.equal(isSecretKey('sb_publishable_abc'), false);
  assert.equal(isSecretKey(jwt('anon')), false);
});

test('the publishable key is sent', async () => {
  process.env.SUPABASE_ANON_KEY = 'sb_publishable_abc';
  const res = GET();
  assert.equal(res.status, 200);
  assert.equal((await res.json()).supabaseAnonKey, 'sb_publishable_abc');
});
