-- 005_review_fixes.sql : fixes from the pre-launch review (apply after 004). Safe to run more than once.

-- 1. Booking abuse limits inside the booking transaction.
create or replace function create_booking(p jsonb)
returns table (id uuid, code text, driver_id uuid, driver_name text, driver_phone text, vehicle_model text, plate text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_arrival timestamp := (p->>'arrival_date')::date + (p->>'arrival_time')::time;
  v_hash    text := p->>'passenger_phone_hash';
  v_driver  drivers%rowtype;
  v_code    text;
  v_id      uuid;
  v_chars   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i         int;
begin
  if v_hash is null or p->>'passenger_phone_enc' is null or p->>'passenger_name_enc' is null or p->>'privacy_notice_version' is null then
    raise exception 'missing_protected_fields';
  end if;

  -- Abuse limits: no bookings more than 90 days ahead, and at most 2 live bookings per phone number.
  if v_arrival > (now() at time zone 'UTC') + interval '90 days' then
    raise exception 'too_far_ahead';
  end if;
  -- One booking at a time per phone number, so two requests at the same moment cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtext(v_hash));
  if (select count(*) from bookings b
       where b.passenger_phone_hash = v_hash and b.status in ('assigned','waiting','met','enroute')
         and b.arrival_date + b.arrival_time::time > (now() at time zone 'UTC') - interval '6 hours') >= 2 then
    raise exception 'too_many_bookings';
  end if;

  -- One airport at a time, matched on the phone number's blind index.
  if exists (
    select 1 from bookings b
     where b.passenger_phone_hash = v_hash
       and b.airport <> p->>'airport'
       and b.status in ('assigned','waiting','met','enroute')
       and abs(extract(epoch from ((b.arrival_date + b.arrival_time::time) - v_arrival))) < 6 * 3600
  ) then
    raise exception 'other_airport';
  end if;

  select d.* into v_driver
    from drivers d
   where d.status = 'approved'
     and d.base_airport = p->>'airport'
     and d.vehicle_type = p->>'vehicle'
     and d.sub_until > now()
     and not exists (
       select 1 from bookings b
        where b.driver_id = d.id
          and b.status in ('assigned','waiting','met','enroute')
          and abs(extract(epoch from ((b.arrival_date + b.arrival_time::time) - v_arrival))) < 3 * 3600
     )
   order by random()
   limit 1
   for update skip locked;

  if not found then
    raise exception 'no_driver';
  end if;

  for attempt in 1..5 loop
    v_code := 'AKW-';
    for i in 1..4 loop
      v_code := v_code || substr(v_chars, 1 + floor(random() * length(v_chars))::int, 1);
    end loop;
    exit when not exists (select 1 from bookings where bookings.code = v_code);
  end loop;

  insert into bookings (
    code, airport, flight, arrival_date, arrival_time, area, zone, vehicle, extras, pax, bags,
    passenger_name_enc, passenger_phone_enc, passenger_email_enc, dest_address_enc, passenger_phone_hash,
    privacy_notice_version, fare_ghs, fare_lines, status, driver_id
  ) values (
    v_code, p->>'airport', p->>'flight', (p->>'arrival_date')::date, p->>'arrival_time', p->>'area',
    p->>'zone', p->>'vehicle',
    coalesce(array(select jsonb_array_elements_text(p->'extras')), '{}'), (p->>'pax')::int, (p->>'bags')::int,
    p->>'passenger_name_enc', p->>'passenger_phone_enc', p->>'passenger_email_enc', p->>'dest_address_enc', v_hash,
    p->>'privacy_notice_version', (p->>'fare_ghs')::int, p->'fare_lines', 'assigned', v_driver.id
  ) returning bookings.id into v_id;

  -- Marketing consent is recorded only when the box was ticked. No row means no consent (Act 843 s.40).
  if (p->>'marketing')::boolean is true then
    insert into consent_events (subject_type, subject_hash, purpose, granted, notice_version, source)
    values ('traveller', v_hash, 'marketing', true, p->>'privacy_notice_version', 'booking_form');
  end if;

  return query select v_id, v_code, v_driver.id, v_driver.name, v_driver.phone, v_driver.vehicle_model, v_driver.plate;
end;
$$;


revoke all on function create_booking(jsonb) from public, anon, authenticated;

-- 2. Consent purge must not fail when a vetting record points at a superseded consent row.
alter table driver_vetting drop constraint if exists driver_vetting_consent_event_id_fkey;
alter table driver_vetting add constraint driver_vetting_consent_event_id_fkey
  foreign key (consent_event_id) references consent_events(id) on delete set null;

-- 3. Current consent: newest row wins, with the id breaking ties between rows written at the same moment.
create or replace view consent_current with (security_invoker = true) as
  select distinct on (subject_hash, purpose) subject_hash, purpose, granted, notice_version, created_at
  from consent_events order by subject_hash, purpose, created_at desc, id desc;
revoke all on consent_current from public, anon, authenticated;
