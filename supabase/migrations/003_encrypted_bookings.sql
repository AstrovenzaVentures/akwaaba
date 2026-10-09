-- 003_encrypted_bookings.sql : switches bookings to encrypted traveller details (apply after 002_privacy.sql)
-- The server encrypts name, phone, email and address before calling create_booking; the database never sees them in plain text.

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

-- Plain-text traveller details can no longer be written. NOT VALID: rows from before the cut-over are
-- checked once you have backfilled them (README, "Encrypting existing bookings"), then run:
--   alter table bookings validate constraint bookings_no_plaintext_pii;
alter table bookings drop constraint if exists bookings_no_plaintext_pii;
alter table bookings add constraint bookings_no_plaintext_pii
  check (passenger_name is null and passenger_phone is null and passenger_email is null and dest_address is null) not valid;

-- The consent view is for the backend only. Without this, Supabase's default grants would let the public API read it.
alter view consent_current set (security_invoker = true);
revoke all on consent_current from public, anon, authenticated;
