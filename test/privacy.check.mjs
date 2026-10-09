import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';

const db = new PGlite();
const q = async (sql, p) => (await db.query(sql, p)).rows;
let pass = 0, fail = 0;
const check = (n, c, x = '') => { if (c) { pass++; console.log('ok  ', n); } else { fail++; console.log('FAIL', n, x); } };

await db.exec(`create schema auth; create table auth.users (id uuid primary key default gen_random_uuid(), email text, phone text);
  create role anon; create role authenticated; create function auth.uid() returns uuid language sql as $$ select null::uuid $$;`);
await db.exec(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/002_privacy.sql', import.meta.url), 'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/002_privacy.sql', import.meta.url), 'utf8')); // re-runnable
await db.exec(fs.readFileSync(new URL('../supabase/migrations/005_review_fixes.sql', import.meta.url), 'utf8'));
await db.exec(fs.readFileSync(new URL('../supabase/migrations/005_review_fixes.sql', import.meta.url), 'utf8')); // re-runnable
check('schema + privacy migrations apply, and migrations are re-runnable', true);

const [u] = await q(`insert into auth.users(email) values ('d@x') returning id`);
await q(`insert into drivers (id,name,phone,email,vehicle_type,plate,status,sub_until) values ($1,'K','+233200000001','d@x','sedan','GR 1','approved', now()+interval '9 days')`, [u.id]);
const mk = (date, status, hash) => q(`insert into bookings (code,airport,flight,arrival_date,arrival_time,area,dest_address,zone,vehicle,pax,bags,
  passenger_name,passenger_phone,passenger_email,fare_ghs,fare_lines,status,driver_id,passenger_phone_hash,passenger_phone_enc)
  values ('AKW-'||substr(md5(random()::text),1,4),'ACC','ET921',$1,'14:00','Osu','Oxford St','ACC-B','sedan',1,1,'Ama','+233244112087','a@x',220,'[]',$2,$3,$4,'v1:enc') returning id`,
  [date, status, u.id, hash]);
const old = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
const recent = new Date(Date.now() - 10 * 864e5).toISOString().slice(0, 10);
const [o1] = await mk(old, 'done', 'h1');
const [o2] = await mk(old, 'assigned', 'h1');    // stuck open trip: not purged automatically
const [r1] = await mk(recent, 'done', 'h1');

const [{ purge_expired_booking_pii: n }] = await q(`select purge_expired_booking_pii(90)`);
check('purge strips PII from one closed booking older than 90 days', n === 1, n);
const [a] = await q(`select passenger_name, passenger_phone, passenger_email, dest_address, passenger_phone_enc, passenger_phone_hash, pii_purged_at, area, fare_ghs, status from bookings where id=$1`, [o1.id]);
check('purged booking has no personal fields left', [a.passenger_name, a.passenger_phone, a.passenger_email, a.dest_address, a.passenger_phone_enc, a.passenger_phone_hash].every((v) => v === null) && a.pii_purged_at);
check('purged booking keeps anonymous trip facts', a.area === 'Osu' && a.fare_ghs === 220 && a.status === 'done');
const [b] = await q(`select passenger_name from bookings where id=$1`, [o2.id]);
check('open trips are not purged automatically', b.passenger_name === 'Ama');
const [c] = await q(`select passenger_name from bookings where id=$1`, [r1.id]);
check('recent trips are kept', c.passenger_name === 'Ama');
const [{ count }] = await q(`select count(*)::int as count from audit_log where action='retention_purge'`);
check('purge is recorded in the audit log', count === 1);

const [{ erase_traveller: e }] = await q(`select erase_traveller('h1')`);
check('erasure removes PII from the remaining closed booking for that person', e === 1, e);

await q(`insert into consent_events (subject_type,subject_hash,purpose,granted,notice_version,source) values ('traveller','h9','marketing',true,'1.0','booking_form')`);
await q(`insert into consent_events (subject_type,subject_hash,purpose,granted,notice_version,source) values ('traveller','h9','marketing',false,'1.0','email_unsubscribe')`);
const [cur] = await q(`select granted from consent_current where subject_hash='h9' and purpose='marketing'`);
check('consent_current shows the latest choice (withdrawn)', cur.granted === false);
let err = null;
try { await q(`delete from consent_events`); } catch (x) { err = x.message; }
check('consent ledger cannot be deleted', /append-only/.test(err || ''), err);
err = null;
try { await q(`update consent_events set granted = true`); } catch (x) { err = x.message; }
check('consent ledger cannot be edited', /append-only/.test(err || ''), err);

err = null;
try { await q(`insert into driver_vetting (driver_id,check_type,result,provider,doc_last4) values ($1,'ghana_card','pass','x','GHA-123456789-0')`, [u.id]); } catch (x) { err = x.message; }
check('vetting table refuses a full document number in doc_last4', !!err);
await q(`insert into driver_vetting (driver_id,check_type,result,provider,doc_last4,doc_number_hash) values ($1,'ghana_card','pass','staff_visual_check','7890','abc')`, [u.id]);
check('vetting result with last 4 characters and hash is accepted', true);

await q(`insert into abuse_flags (subject_hash, reason, created_at) values ('h1','no_show', now() - interval '13 months'), ('h1','no_show', now())`);
const [{ purge_expired_abuse_flags: f }] = await q(`select purge_expired_abuse_flags()`);
check('abuse flags older than 12 months are deleted', f === 1, f);

// consent retention purge
await q(`insert into consent_events (subject_type,subject_hash,purpose,granted,notice_version,source,created_at) values
  ('traveller','old-out','marketing',true,'1.0','booking_form', now() - interval '4 years'),
  ('traveller','old-out','marketing',false,'1.0','email_unsubscribe', now() - interval '3 years'),
  ('traveller','still-in','marketing',true,'1.0','booking_form', now() - interval '5 years'),
  ('traveller','re-in','marketing',true,'1.0','booking_form', now() - interval '3 years'),
  ('traveller','re-in','marketing',true,'1.1','settings', now() - interval '1 day')`);
const [{ purge_old_consent_events: cp }] = await q(`select purge_old_consent_events()`);
const left = await q(`select subject_hash, notice_version from consent_events where subject_hash in ('old-out','still-in','re-in') order by subject_hash`);
check('consent purge removes records 2 years after withdrawal and superseded old records', cp === 3, cp);
check('consent purge keeps the current choice of active subscribers', JSON.stringify(left) === JSON.stringify([{ subject_hash: 're-in', notice_version: '1.1' }, { subject_hash: 'still-in', notice_version: '1.0' }]), JSON.stringify(left));
err = null;
try { await q(`delete from consent_events where subject_hash='still-in'`); } catch (x) { err = x.message; }
check('outside the purge, consent records still cannot be deleted', /append-only/.test(err || ''), err);

// Vetting records that point at an old, superseded consent row do not block the consent purge.
const [oldC] = await q(`insert into consent_events (subject_type, subject_hash, purpose, granted, notice_version, source, created_at)
  values ('driver','vet-h','driver_vetting',true,'0.9','driver_application', now() - interval '3 years') returning id`);
await q(`insert into consent_events (subject_type, subject_hash, purpose, granted, notice_version, source) values ('driver','vet-h','driver_vetting',true,'1.0','driver_app')`);
await q(`insert into driver_vetting (driver_id, check_type, result, provider, consent_event_id) values ($1,'ghana_card','pass','staff_visual_check',$2)`, [u.id, oldC.id]);
let purgeErr = null;
try { await q(`select purge_old_consent_events()`); } catch (e) { purgeErr = e.message; }
const [vet] = await q(`select consent_event_id from driver_vetting where check_type='ghana_card' and driver_id=$1`, [u.id]);
check('consent purge succeeds when vetting records point at a superseded consent', !purgeErr && vet.consent_event_id === null, purgeErr);

// Two consent rows written at the same instant: the later one (higher id) is the current choice.
await q(`insert into consent_events (subject_type, subject_hash, purpose, granted, notice_version, source, created_at)
  values ('traveller','tie-h','marketing',true,'1.0','booking_form','2026-01-01T00:00:00Z'), ('traveller','tie-h','marketing',false,'1.0','email_unsubscribe','2026-01-01T00:00:00Z')`);
const [tie] = await q(`select granted from consent_current where subject_hash='tie-h' and purpose='marketing'`);
check('consent_current breaks timestamp ties by id (a withdrawal wins)', tie.granted === false, JSON.stringify(tie));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
