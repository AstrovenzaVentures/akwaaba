import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quoteFare, isNight, zoneForArea, SUBSCRIPTION_PESEWAS } from '../lib/pricing.js';

const zones = [
  { zone: 'ACC-A', airport: 'ACC', label: 'Zone A', areas: ['East Legon', 'Cantonments'], sedan_ghs: 150 },
  { zone: 'ACC-B', airport: 'ACC', label: 'Zone B', areas: ['Osu', 'Spintex'], sedan_ghs: 220 },
  { zone: 'ACC-C', airport: 'ACC', label: 'Zone C', areas: ['Tema', 'Madina'], sedan_ghs: 320 },
  { zone: 'ACC-D', airport: 'ACC', label: 'Zone D', areas: ['Kasoa', 'Aburi'], sedan_ghs: 480 }
];

test('subscription is GHS 100 in pesewas', () => assert.equal(SUBSCRIPTION_PESEWAS, 10000));

test('zone is found from the drop-off area, ignoring case and spaces', () => {
  assert.equal(zoneForArea('East Legon', zones).zone, 'ACC-A');
  assert.equal(zoneForArea('  osu ', zones).zone, 'ACC-B');
  assert.equal(zoneForArea('TEMA', zones).zone, 'ACC-C');
  assert.equal(zoneForArea('Aburi', zones).zone, 'ACC-D');
  assert.equal(zoneForArea('Adum', zones), null, 'a Kumasi area is not in the Accra list');
  assert.equal(zoneForArea('Lagos', zones), null);
  assert.equal(zoneForArea('', zones), null);
});

test('fare is the zone fare with no processing fee', () => {
  const q = quoteFare({ zoneFareGhs: 220, vehicle: 'sedan', extras: [], arrivalTime: '14:25' });
  assert.equal(q.totalGhs, 220);
  assert.equal(q.lines.length, 1);
  assert.ok(!q.lines.some((l) => /paystack|processing/i.test(l.label)));
});

test('SUV with extras and night surcharge', () => {
  // 220 x 1.5 = 330; night 20% = 66 -> 65; meet 50 + child 40
  const q = quoteFare({ zoneFareGhs: 220, vehicle: 'suv', extras: ['meet', 'child'], arrivalTime: '23:15' });
  assert.deepEqual(q.lines.map((l) => l.ghs), [330, 65, 50, 40]);
  assert.equal(q.totalGhs, 485);
});

test('fares are whole cedis, easy to pay in cash', () => {
  for (const z of [150, 220, 320, 480]) for (const v of ['sedan', 'suv', 'van']) for (const t of ['14:00', '23:00']) {
    const q = quoteFare({ zoneFareGhs: z, vehicle: v, extras: ['meet'], arrivalTime: t });
    assert.ok(Number.isInteger(q.totalGhs) && q.totalGhs % 5 === 0, `${z} ${v} ${t}: ${q.totalGhs}`);
  }
});

test('night window is 22:00 to 04:59', () => {
  assert.equal(isNight('21:59'), false);
  assert.equal(isNight('22:00'), true);
  assert.equal(isNight('04:59'), true);
  assert.equal(isNight('05:00'), false);
  assert.equal(isNight(undefined), false);
});

test('rejects unknown vehicle, extra or bad fare', () => {
  assert.throws(() => quoteFare({ zoneFareGhs: 150, vehicle: 'jet' }));
  assert.throws(() => quoteFare({ zoneFareGhs: 150, vehicle: 'sedan', extras: ['free_ride'] }));
  assert.throws(() => quoteFare({ zoneFareGhs: -5, vehicle: 'sedan' }));
});
