// Subscription countdown shown to drivers and staff (public/common.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subStatus, SUB_WARN_DAYS } from '../public/common.js';

const now = Date.parse('2026-10-10T12:00:00Z');
const at = (days) => new Date(now + days * 864e5).toISOString();

test('never paid, expired, ending soon and active are told apart', () => {
  assert.equal(subStatus(null, now).state, 'never');
  assert.equal(subStatus(at(-0.01), now).state, 'expired');
  assert.equal(subStatus(at(0), now).state, 'expired', 'the exact end moment counts as ended');
  assert.deepEqual([subStatus(at(0.5), now).state, subStatus(at(0.5), now).days], ['soon', 1]);
  assert.equal(subStatus(at(SUB_WARN_DAYS), now).state, 'soon');
  assert.deepEqual([subStatus(at(SUB_WARN_DAYS + 0.5), now).state, subStatus(at(SUB_WARN_DAYS + 0.5), now).days], ['active', 4]);
  assert.equal(subStatus(at(30), now).days, 30);
});
