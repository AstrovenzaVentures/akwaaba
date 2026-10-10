// Runs supabase/schema.sql on a real Postgres engine (PGlite) and checks the booking and subscription rules.
// npm run test:db
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const db = new PGlite();
const q = async (sql, params) => (await db.query(sql, params)).rows;
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('ok  ', name); } else { fail++; console.log('FAIL', name, extra); } };

// Minimal Supabase stand-ins
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text);
  create role anon; create role authenticated;
  create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
`);
for (const f of ['schema.sql', 'migrations/002_privacy.sql', 'migrations/003_encrypted_bookings.sql', 'migrations/005_review_fixes.sql', 'migrations/006_manual_payments.sql', 'migrations/006_manual_payments.sql', 'migrations/007_woezor_codes.sql']) {
  await db.exec(fs.readFileSync(new URL(`../supabase/${f}`, import.meta.url), 'utf8'));
}
check('schema and privacy migrations load', true);
const zrows = await q(`select zone, areas from zone_fares order by zone`);
check('eight zones seeded (4 Accra, 4 Kumasi) with areas', zrows.length === 8 && zrows.every((z) => z.areas.length > 3));
const arows = await q(`select code from airports order by code`);
check('airports ACC and KMS seeded', arows.map((a) => a.code).join() === 'ACC,KMS');
const dup = await q(`select a from zone_fares, unnest(areas) a group by a having count(*) > 1`);
check('no area is listed in two zones', dup.length === 0, JSON.stringify(dup));

const [u1] = await q(`insert into auth.users(email) values ('a@x.com') returning id`);
const [u2] = await q(`insert into auth.users(email) values ('b@x.com') returning id`);
const [u3] = await q(`insert into auth.users(email) values ('c@x.com') returning id`);
await q(`insert into drivers (id,name,phone,email,vehicle_type,vehicle_model,plate,status,sub_until) values
  ($1,'Kwame','+233200000001','a@x.com','sedan','Toyota Corolla','GR 1','approved', now() + interval '10 days'),
  ($2,'Abena','+233200000002','b@x.com','sedan','Hyundai Elantra','GR 2','approved', now() - interval '1 day'),
  ($3,'Kojo','+233200000003','c@x.com','sedan','Kia Rio','GR 3','pending_review', now() + interval '5 days')`, [u1.id, u2.id, u3.id]);
const [u4] = await q(`insert into auth.users(email) values ('d@x.com') returning id`);
await q(`insert into drivers (id,name,phone,email,vehicle_type,vehicle_model,plate,status,sub_until,base_airport) values
  ($1,'Ama Kumasi','+233200000004','d@x.com','sedan','Toyota Vitz','AS 4','approved', now() + interval '10 days','KMS')`, [u4.id]);

const date = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10);
// The server sends encrypted fields and a phone hash, never plain text (stand-in values here; real ones come from lib/privacy.js).
let phoneSeq = 0;
const trip = ({ passenger_phone = '+23324411' + String(2000 + phoneSeq++).padStart(4, '0'), ...over } = {}) => JSON.stringify({
  airport: 'ACC', flight: 'ET921', arrival_date: date, arrival_time: '14:25', area: 'Osu', zone: 'ACC-B',
  vehicle: 'sedan', extras: ['meet'], pax: 2, bags: 2,
  passenger_name_enc: 'v1:enc-name', passenger_phone_enc: 'v1:enc-' + passenger_phone, passenger_email_enc: null,
  dest_address_enc: 'v1:enc-address', passenger_phone_hash: 'hash-' + passenger_phone,
  privacy_notice_version: '1.0', marketing: false,
  fare_ghs: 270, fare_lines: [{ label: 'Sedan fare', ghs: 220 }, { label: 'Meet', ghs: 50 }], ...over
});

// 1. Only an approved driver with an active subscription gets the booking
const [b1] = await q(`select * from create_booking($1::jsonb)`, [trip({ passenger_phone: '+233244112087' })]);
check('booking goes to the approved, subscribed driver', b1.driver_name === 'Kwame' && b1.plate === 'GR 1', JSON.stringify(b1));
check('booking returns the driver phone for WhatsApp', b1.driver_phone === '+233200000001', b1.driver_phone);
const [row1] = await q(`select status, fare_ghs, extras, passenger_email, area, passenger_name, passenger_phone, dest_address,
  passenger_phone_enc, passenger_phone_hash, privacy_notice_version from bookings where id=$1`, [b1.id]);
check('no plain-text traveller details stored', [row1.passenger_name, row1.passenger_phone, row1.dest_address].every((v) => v === null));
check('encrypted phone, phone hash and notice version stored', row1.passenger_phone_enc === 'v1:enc-+233244112087' && row1.passenger_phone_hash === 'hash-+233244112087' && row1.privacy_notice_version === '1.0');
const [noMk] = await q(`select count(*)::int n from consent_events`);
check('no marketing box ticked: no consent recorded', noMk.n === 0);
check('booking is confirmed immediately (no payment step)', row1.status === 'assigned');
check('fare stored in whole cedis', row1.fare_ghs === 270);
check('drop-off area stored', row1.area === 'Osu');
check('email may be empty', row1.passenger_email === null);
check('extras stored as array', JSON.stringify(row1.extras) === '["meet"]');
check('booking code format (WZR-)', /^WZR-[A-Z2-9]{4}$/.test(b1.code), b1.code);

// 2. Same time again: Kwame busy, Abena's subscription expired, Kojo not approved -> no driver
let err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip()]); } catch (e) { err = e.message; }
check('no driver when the others are expired or not approved', /no_driver/.test(err || ''), err);

// 2b. A Kumasi booking goes to the Kumasi-based driver, never to an Accra driver
const [k1] = await q(`select * from create_booking($1::jsonb)`, [trip({ airport: 'KMS', area: 'Adum', zone: 'KMS-B', flight: 'AW102', passenger_phone: '+233209990001' })]);
check('Kumasi booking goes to the Kumasi-based driver', k1.driver_name === 'Ama Kumasi', JSON.stringify(k1));
err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip({ airport: 'KMS', area: 'Adum', zone: 'KMS-B', flight: 'AW104', arrival_time: '14:40', passenger_phone: '+233209990002' })]); } catch (e) { err = e.message; }
check('second Kumasi booking at that time finds no driver (Accra drivers are not used)', /no_driver/.test(err || ''), err);

// 2c. One airport at a time: the same passenger cannot also book Kumasi around their Accra pickup
err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip({ airport: 'KMS', area: 'Adum', zone: 'KMS-B', flight: 'AW106', arrival_time: '16:00', passenger_phone: '+233244112087' })]); } catch (e) { err = e.message; }
check('same passenger cannot hold Accra and Kumasi bookings within 6 hours', /other_airport/.test(err || ''), err);

// 3. Five hours later Kwame is free again
const [b2] = await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '19:30' })]);
check('driver free again outside the 3-hour window', b2.driver_name === 'Kwame');

// 4. A completed or no-show trip frees the driver
await q(`update bookings set status='no_show' where id=$1`, [b1.id]);
const [b3] = await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '14:40' })]);
check('no-show frees the driver for another pickup', b3.driver_name === 'Kwame');

// 5. Renewing a lapsed subscription brings the driver back
await q(`insert into payments(reference,driver_id,amount_pesewas) values ('AKW_SUB_2',$1,10000)`, [u2.id]);
const [r] = await q(`select apply_payment('AKW_SUB_2', 333, now(), 'mobile_money', 30) as o`);
check('subscription payment applied', r.o === 'subscription_extended', r.o);
const [ab] = await q(`select sub_until from drivers where id=$1`, [u2.id]);
const fromNow = (new Date(ab.sub_until) - Date.now()) / 864e5;
check('expired subscription restarts from today for 30 days', fromNow > 29.9 && fromNow < 30.1, fromNow);
const [b4] = await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '14:50' })]);
check('renewed driver receives pickups again', b4.driver_name === 'Abena', JSON.stringify(b4));

// 6. Active subscription extends from its end date, and a replayed payment does nothing
await q(`insert into payments(reference,driver_id,amount_pesewas) values ('AKW_SUB_1',$1,10000)`, [u1.id]);
const [before] = await q(`select sub_until from drivers where id=$1`, [u1.id]);
await q(`select apply_payment('AKW_SUB_1', 222, now(), 'card', 30)`);
const [again] = await q(`select apply_payment('AKW_SUB_1', 222, now(), 'card', 30) as o`);
const [after] = await q(`select sub_until from drivers where id=$1`, [u1.id]);
const added = (new Date(after.sub_until) - new Date(before.sub_until)) / 864e5;
check('active subscription extended by exactly 30 days', Math.abs(added - 30) < 0.01, added);
check('replayed payment ignored', again.o === 'already_handled', again.o);

// 7. Unknown reference does nothing
const [r3] = await q(`select apply_payment('AKW_SUB_nope', 1, now(), 'card', 30) as o`);
check('unknown reference ignored', r3.o === 'already_handled');

// 7b. Privacy rules in the database
err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '23:00', passenger_phone_hash: null })]); } catch (e) { err = e.message; }
check('booking without encrypted fields is refused', /missing_protected_fields/.test(err || ''), err);
const [mk] = await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '08:00', passenger_phone: '+233209990003', marketing: true })]);
const consents = await q(`select subject_type, subject_hash, purpose, granted, notice_version, source from consent_events`);
check('ticked marketing box recorded once in the consent ledger', consents.length === 1 && consents[0].purpose === 'marketing' && consents[0].granted
  && consents[0].subject_hash === 'hash-+233209990003' && consents[0].source === 'booking_form', JSON.stringify(consents));
err = null;
try { await q(`update bookings set passenger_phone='+233244112087' where id=$1`, [mk.id]); } catch (e) { err = e.message; }
check('plain-text phone can no longer be written', /bookings_no_plaintext_pii/.test(err || ''), err);
err = null;
try { await q(`update consent_events set granted=false`); } catch (e) { err = e.message; }
check('consent ledger cannot be edited', /append-only/.test(err || ''), err);

// 7c. Abuse limits
const capPhone = '+233209990077';
await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '06:00', passenger_phone: capPhone, vehicle: 'sedan' })]).catch(() => {});
const capRows = await q(`select count(*)::int n from bookings where passenger_phone_hash = $1`, ['hash-' + capPhone]);
await q(`insert into bookings (code, airport, flight, arrival_date, arrival_time, area, zone, vehicle, pax, bags, fare_ghs, fare_lines, status, driver_id, passenger_phone_hash, passenger_name_enc, passenger_phone_enc, privacy_notice_version)
  select 'AKW-CAP' || g, 'ACC', 'ET921', $1::date, '05:00', 'Osu', 'ACC-B', 'sedan', 1, 0, 220, '[]', 'assigned', $2, $3, 'x', 'x', '1.0' from generate_series(1, 2 - $4::int) g`,
  [date, u1.id, 'hash-' + capPhone, capRows[0].n]);
err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '21:00', passenger_phone: capPhone })]); } catch (e) { err = e.message; }
check('a phone number cannot hold more than 2 live bookings', /too_many_bookings/.test(err || ''), err);
const stalePhone = '+233209990079';
const past = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
await q(`insert into bookings (code, airport, flight, arrival_date, arrival_time, area, zone, vehicle, pax, bags, fare_ghs, fare_lines, status, driver_id, passenger_phone_hash, passenger_name_enc, passenger_phone_enc, privacy_notice_version)
  select 'AKW-OLD' || g, 'ACC', 'ET921', $1::date, '05:00', 'Osu', 'ACC-B', 'sedan', 1, 0, 220, '[]', 'assigned', $2, $3, 'x', 'x', '1.0' from generate_series(1, 2) g`,
  [past, u1.id, 'hash-' + stalePhone]);
err = null;
try { await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_time: '22:30', passenger_phone: stalePhone })]); } catch (e) { err = e.message; }
check('old trips nobody closed do not count towards the 2-booking limit', !/too_many_bookings/.test(err || ''), err);
err = null;
const far = new Date(Date.now() + 120 * 864e5).toISOString().slice(0, 10);
try { await q(`select * from create_booking($1::jsonb)`, [trip({ arrival_date: far, passenger_phone: '+233209990078' })]); } catch (e) { err = e.message; }
check('bookings more than 90 days ahead are refused by the database', /too_far_ahead/.test(err || ''), err);

// 8. Constraints: only subscription payments exist; trip status must be valid
err = null;
try { await q(`insert into payments(reference,kind,driver_id,amount_pesewas) values ('X','fare',$1,100)`, [u1.id]); } catch (e) { err = e.message; }
check('fare payments cannot be recorded', !!err);
err = null;
try { await q(`update bookings set status='teleported' where id=$1`, [b2.id]); } catch (e) { err = e.message; }
check('invalid trip status rejected', !!err);

// 9. Direct MoMo/bank payments (migration 006)
const accts = await q(`select method, active from payment_accounts order by sort`);
check('four payment accounts seeded, all switched off until filled in', accts.length === 4 && accts.every((a) => !a.active), JSON.stringify(accts));
const [sub0] = await q(`select sub_until from drivers where id=$1`, [u2.id]);
await q(`insert into payments(reference,driver_id,amount_pesewas,status,method,manual_txn_id,payer_account,proof_path)
         values ('AKW_MAN_1',$1,10000,'submitted','mtn','TX123','0244','d/p.png')`, [u2.id]);
err = null;
try { await q(`insert into payments(reference,driver_id,amount_pesewas,status,method,manual_txn_id) values ('AKW_MAN_2',$1,10000,'submitted','mtn','TX999')`, [u2.id]); } catch (e) { err = e.message; }
check('a driver can have only one direct payment waiting at a time', /one_open_claim/.test(err || ''), err);
err = null;
try { await q(`insert into payments(reference,driver_id,amount_pesewas,status,method,manual_txn_id) values ('AKW_MAN_3',$1,10000,'submitted','mtn','tx123')`, [u1.id]); } catch (e) { err = e.message; }
check('the same transaction ID cannot be claimed twice (any letter case)', /manual_txn_uniq/.test(err || ''), err);
err = null;
try { await q(`insert into payments(reference,driver_id,amount_pesewas,method) values ('AKW_X',$1,10000,'cash')`, [u1.id]); } catch (e) { err = e.message; }
check('unknown payment methods are refused', !!err);
const [staffU] = await q(`insert into auth.users(email) values ('s@x.com') returning id`);
const [m1] = await q(`select review_manual_payment('AKW_MAN_1',$1,true,null,30) as o`, [staffU.id]);
const [sub1] = await q(`select sub_until from drivers where id=$1`, [u2.id]);
const [pm1] = await q(`select status, reviewed_by, paid_at from payments where reference='AKW_MAN_1'`);
check('confirming a direct payment marks it paid and adds 30 days to the current subscription',
  m1.o === 'subscription_extended' && pm1.status === 'success' && pm1.reviewed_by === staffU.id && !!pm1.paid_at &&
  Math.abs(new Date(sub1.sub_until) - (Math.max(+new Date(sub0.sub_until), Date.now()) + 30 * 864e5)) < 60e3, JSON.stringify({ m1, pm1, sub0, sub1 }));
const [m2] = await q(`select review_manual_payment('AKW_MAN_1',$1,true,null,30) as o`, [staffU.id]);
const [sub2] = await q(`select sub_until from drivers where id=$1`, [u2.id]);
check('confirming twice does nothing the second time', m2.o === 'already_handled' && +new Date(sub2.sub_until) === +new Date(sub1.sub_until));
await q(`insert into payments(reference,driver_id,amount_pesewas,status,method,manual_txn_id) values ('AKW_MAN_4',$1,10000,'submitted','telecel','TEL1')`, [u1.id]);
const [sub3] = await q(`select sub_until from drivers where id=$1`, [u1.id]);
const [m3] = await q(`select review_manual_payment('AKW_MAN_4',$1,false,'Not on statement',30) as o`, [staffU.id]);
const [pm4] = await q(`select status, reject_reason from payments where reference='AKW_MAN_4'`);
const [sub4] = await q(`select sub_until from drivers where id=$1`, [u1.id]);
check('rejecting keeps the subscription unchanged and records the reason',
  m3.o === 'rejected' && pm4.status === 'rejected' && pm4.reject_reason === 'Not on statement' && +new Date(sub3.sub_until) === +new Date(sub4.sub_until));
await q(`insert into payments(reference,driver_id,amount_pesewas,status,method,manual_txn_id) values ('AKW_MAN_5',$1,10000,'submitted','telecel','TEL1')`, [u1.id]);
check('a rejected transaction ID can be sent again (e.g. after a typo fix)', true);
const [pp] = await q(`select apply_payment('AKW_MAN_5', 1, now(), 'x', 30) as o`);
check('the Paystack settlement path cannot confirm a direct payment', pp.o === 'already_handled');
const grants = await q(`select has_function_privilege('anon','review_manual_payment(text,uuid,boolean,text,integer)','execute') a,
                               has_function_privilege('authenticated','review_manual_payment(text,uuid,boolean,text,integer)','execute') b`);
check('browsers cannot call the staff payment decision directly', !grants[0].a && !grants[0].b);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
