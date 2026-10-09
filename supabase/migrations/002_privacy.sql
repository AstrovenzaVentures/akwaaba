-- 002_privacy.sql : privacy and retention controls for Akwaaba (apply after schema.sql)

-- 1. Encrypted PII columns + blind indexes on bookings
alter table bookings
  add column if not exists passenger_name_enc   text,          -- AES-256-GCM, "v1:<iv>:<tag>:<ciphertext>" base64
  add column if not exists passenger_phone_enc  text,
  add column if not exists passenger_email_enc  text,
  add column if not exists dest_address_enc     text,
  add column if not exists passenger_phone_hash text,          -- HMAC-SHA256 blind index, hex
  add column if not exists privacy_notice_version text,
  add column if not exists pii_purged_at        timestamptz;

create index if not exists bookings_phone_hash_idx on bookings (passenger_phone_hash, arrival_date);

-- Plaintext columns become nullable so they can be emptied after cut-over and by purge.
alter table bookings alter column passenger_name drop not null;
alter table bookings alter column passenger_phone drop not null;
alter table bookings alter column dest_address drop not null;

-- 2. Consent ledger (append-only)
create table if not exists consent_events (
  id             bigserial primary key,
  subject_type   text not null check (subject_type in ('traveller','driver')),
  subject_hash   text not null,                   -- HMAC of phone number, never the number itself
  purpose        text not null check (purpose in ('privacy_notice','marketing','driver_vetting','driver_location','push_notifications')),
  granted        boolean not null,
  notice_version text not null,
  source         text not null,                   -- 'booking_form', 'driver_onboarding', 'settings', 'email_unsubscribe'
  created_at     timestamptz not null default now()
);
create index if not exists consent_subject_idx on consent_events (subject_hash, purpose, created_at desc);

create or replace function consent_events_append_only() returns trigger language plpgsql as $$
begin
  -- The only permitted removal is the retention purge below, which sets this flag for its own transaction.
  if tg_op = 'DELETE' and current_setting('akwaaba.retention_purge', true) = 'on' then
    return old;
  end if;
  raise exception 'consent_events is append-only';
end $$;
drop trigger if exists consent_events_no_change on consent_events;
create trigger consent_events_no_change before update or delete on consent_events
  for each row execute function consent_events_append_only();

-- Current state per subject and purpose
create or replace view consent_current as
  select distinct on (subject_hash, purpose) subject_hash, purpose, granted, notice_version, created_at
  from consent_events order by subject_hash, purpose, created_at desc;

-- 3. Data subject requests register
create table if not exists dsar_requests (
  id             uuid primary key default gen_random_uuid(),
  subject_hash   text not null,
  kind           text not null check (kind in ('access','correction','erasure','objection','portability','restriction','marketing_optout','automated_review')),
  received_at    timestamptz not null default now(),
  identity_verified_at timestamptz,
  due_at         timestamptz not null default now() + interval '30 days',   -- internal SLA (Act 843 limit 40 days, GDPR 1 month)
  completed_at   timestamptz,
  outcome        text,
  handled_by     uuid references auth.users(id)
);

-- 4. Abuse-prevention record (hash only, 12 months)
create table if not exists abuse_flags (
  id            bigserial primary key,
  subject_hash  text not null,
  reason        text not null check (reason in ('no_show','other_airport_block','rate_limit')),
  booking_code  text,
  created_at    timestamptz not null default now()
);
create index if not exists abuse_flags_subject_idx on abuse_flags (subject_hash, created_at desc);

-- 5. Driver vetting results (no document images)
create table if not exists driver_vetting (
  id               bigserial primary key,
  driver_id        uuid not null references drivers(id) on delete cascade,
  check_type       text not null check (check_type in ('ghana_card','drivers_licence','dvla_ride_hailing','police_clearance','vehicle_roadworthy')),
  result           text not null check (result in ('pass','fail','expired','manual_review')),
  provider         text not null,          -- 'staff_visual_check' or the verification provider's name
  provider_ref     text,                   -- provider's transaction id, not the document number
  doc_number_hash  text,                   -- HMAC of the document number (to detect re-use), never the number
  doc_last4        text check (doc_last4 ~ '^[A-Z0-9]{0,4}$'),
  expires_on       date,
  consent_event_id bigint references consent_events(id),
  checked_by       uuid references auth.users(id),
  checked_at       timestamptz not null default now()
);

-- 6. Retention / purge job: strip passenger PII 90 days after landing, keep anonymous trip facts.
create or replace function purge_expired_booking_pii(p_days integer default 90) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update bookings
     set passenger_name = null, passenger_phone = null, passenger_email = null, dest_address = null,
         passenger_name_enc = null, passenger_phone_enc = null, passenger_email_enc = null, dest_address_enc = null,
         passenger_phone_hash = null, pii_purged_at = now()
   where pii_purged_at is null
     and arrival_date < (now() at time zone 'UTC')::date - p_days
     and status in ('done','no_show','cancelled');
  get diagnostics n = row_count;
  insert into audit_log (actor, action, target, detail) values (null, 'retention_purge', 'bookings', jsonb_build_object('rows', n, 'days', p_days));
  return n;
end $$;

create or replace function purge_expired_abuse_flags() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from abuse_flags where created_at < now() - interval '12 months';
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function purge_old_audit_log() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from audit_log where created_at < now() - interval '2 years' and action <> 'retention_purge';
  get diagnostics n = row_count;
  return n;
end $$;

-- Consent records: keep the current choice; delete superseded records older than 2 years,
-- and delete everything for a purpose 2 years after the person withdrew.
create or replace function purge_old_consent_events() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('akwaaba.retention_purge', 'on', true);
  with latest as (
    select distinct on (subject_hash, purpose) id, subject_hash, purpose, granted, created_at
    from consent_events order by subject_hash, purpose, created_at desc, id desc
  )
  delete from consent_events e
   using latest l
   where e.subject_hash = l.subject_hash and e.purpose = l.purpose
     and (
       (e.id <> l.id and e.created_at < now() - interval '2 years')
       or (l.granted = false and l.created_at < now() - interval '2 years')
     );
  get diagnostics n = row_count;
  perform set_config('akwaaba.retention_purge', 'off', true);
  return n;
end $$;

-- 7. Erasure on request: same as purge but immediate for one subject's closed bookings.
create or replace function erase_traveller(p_phone_hash text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update bookings
     set passenger_name = null, passenger_phone = null, passenger_email = null, dest_address = null,
         passenger_name_enc = null, passenger_phone_enc = null, passenger_email_enc = null, dest_address_enc = null,
         passenger_phone_hash = null, pii_purged_at = now()
   where passenger_phone_hash = p_phone_hash
     and status in ('done','no_show','cancelled');
  get diagnostics n = row_count;
  insert into audit_log (actor, action, target, detail) values (null, 'erasure', 'bookings', jsonb_build_object('rows', n));
  return n;
end $$;

revoke all on function purge_expired_booking_pii(integer), purge_expired_abuse_flags(), purge_old_audit_log(), purge_old_consent_events(), erase_traveller(text)
  from public, anon, authenticated;

-- 8. Row level security on the new tables: no app-user access at all; backend uses the service role.
alter table consent_events enable row level security;
alter table dsar_requests  enable row level security;
alter table abuse_flags    enable row level security;
alter table driver_vetting enable row level security;
