-- Akwaaba database schema (Supabase / Postgres)
-- Run once in Supabase > SQL Editor. Owner: Astrovenza Ventures.
-- Money model: Astrovenza collects only the GHS 100 driver subscription (through Paystack).
-- Travellers pay the driver directly on arrival, in cash or mobile money. No fare money passes through Akwaaba.

-- ---------- Tables ----------

create table if not exists airports (
  code        text primary key check (code ~ '^[A-Z]{3}$'),   -- IATA code
  name        text not null,
  city        text not null,
  pickup_note text not null,                                  -- where travellers meet their driver
  active      boolean not null default true
);

-- Zones belong to one airport. Zone ids are airport code + letter, e.g. ACC-A, KMS-B.
create table if not exists zone_fares (
  zone        text primary key check (zone ~ '^[A-Z]{3}-[A-Z]$'),
  airport     text not null references airports(code),
  label       text not null,
  areas       text[] not null,                        -- drop-off areas priced at this zone's fare
  sedan_ghs   integer not null check (sedan_ghs > 0),
  updated_at  timestamptz not null default now()
);

create table if not exists drivers (
  id                        uuid primary key references auth.users(id) on delete cascade,
  name                      text not null,
  phone                     text not null unique,
  email                     text not null,            -- Paystack needs an email for subscription receipts
  vehicle_type              text not null check (vehicle_type in ('sedan','suv','van')),
  vehicle_model             text,
  plate                     text not null unique,
  base_airport              text not null default 'ACC' references airports(code),   -- driver only gets pickups here
  status                    text not null default 'pending_review' check (status in ('pending_review','approved','suspended')),
  sub_until                 timestamptz,
  created_at                timestamptz not null default now()
);

create table if not exists staff (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  role        text not null default 'operator' check (role in ('operator','admin')),
  created_at  timestamptz not null default now()
);

create table if not exists bookings (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  airport              text not null references airports(code),
  flight               text not null,
  arrival_date         date not null,
  arrival_time         text not null,
  area                 text not null,
  dest_address         text not null,                  -- address or landmark; exact location is shared on WhatsApp
  zone                 text not null references zone_fares(zone),
  vehicle              text not null check (vehicle in ('sedan','suv','van')),
  extras               text[] not null default '{}',
  pax                  integer not null check (pax between 1 and 7),
  bags                 integer not null check (bags between 0 and 10),
  passenger_name       text not null,
  passenger_phone      text not null,
  passenger_email      text,
  fare_ghs             integer not null check (fare_ghs > 0),   -- paid by the traveller to the driver on arrival
  fare_lines           jsonb not null,
  status               text not null default 'assigned'
                       check (status in ('assigned','waiting','met','enroute','done','cancelled','no_show')),
  driver_id            uuid not null references drivers(id),
  waiting_at           timestamptz,
  met_at               timestamptz,
  enroute_at           timestamptz,
  done_at              timestamptz,
  created_at           timestamptz not null default now()
);
create index if not exists bookings_driver_idx on bookings(driver_id, arrival_date, status);

-- Driver subscription payments only.
create table if not exists payments (
  reference          text primary key,
  kind               text not null default 'subscription' check (kind = 'subscription'),
  driver_id          uuid not null references drivers(id),
  amount_pesewas     integer not null check (amount_pesewas > 0),
  currency           text not null default 'GHS',
  status             text not null default 'pending' check (status in ('pending','success','flagged')),
  authorization_url  text,
  paystack_id        bigint unique,
  channel            text,
  paid_at            timestamptz,
  note               text,
  created_at         timestamptz not null default now()
);
create index if not exists payments_driver_idx on payments(driver_id, kind, status, created_at desc);

create table if not exists audit_log (
  id          bigserial primary key,
  actor       uuid references auth.users(id),
  action      text not null,
  target      text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

-- ---------- Booking creation with driver reservation (one transaction) ----------
-- A driver is free if they have no live trip whose arrival is within 3 hours of this one.

create or replace function create_booking(p jsonb)
returns table (id uuid, code text, driver_id uuid, driver_name text, driver_phone text, vehicle_model text, plate text)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_arrival timestamp := (p->>'arrival_date')::date + (p->>'arrival_time')::time;
  v_driver  drivers%rowtype;
  v_code    text;
  v_id      uuid;
  v_chars   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i         int;
begin
  -- One airport at a time: the same passenger cannot hold live bookings at two airports within 6 hours.
  if exists (
    select 1 from bookings b
     where b.passenger_phone = p->>'passenger_phone'
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
    code, airport, flight, arrival_date, arrival_time, area, dest_address, zone, vehicle, extras, pax, bags,
    passenger_name, passenger_phone, passenger_email, fare_ghs, fare_lines, status, driver_id
  ) values (
    v_code, p->>'airport', p->>'flight', (p->>'arrival_date')::date, p->>'arrival_time', p->>'area', p->>'dest_address',
    p->>'zone', p->>'vehicle',
    coalesce(array(select jsonb_array_elements_text(p->'extras')), '{}'), (p->>'pax')::int, (p->>'bags')::int,
    p->>'passenger_name', p->>'passenger_phone', p->>'passenger_email', (p->>'fare_ghs')::int, p->'fare_lines',
    'assigned', v_driver.id
  ) returning bookings.id into v_id;

  return query select v_id, v_code, v_driver.id, v_driver.name, v_driver.phone, v_driver.vehicle_model, v_driver.plate;
end;
$$;

-- ---------- Subscription payment settlement (one transaction) ----------

create or replace function apply_payment(
  p_reference text, p_paystack_id bigint, p_paid_at timestamptz, p_channel text, p_sub_days integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p payments%rowtype;
begin
  update payments
     set status = 'success', paystack_id = p_paystack_id, paid_at = p_paid_at, channel = p_channel
   where reference = p_reference and status = 'pending'
  returning * into p;

  if not found then
    return 'already_handled';
  end if;

  update drivers
     set sub_until = greatest(coalesce(sub_until, now()), now()) + make_interval(days => p_sub_days)
   where id = p.driver_id;
  return 'subscription_extended';
end;
$$;

revoke all on function create_booking(jsonb) from public, anon, authenticated;
revoke all on function apply_payment(text, bigint, timestamptz, text, integer) from public, anon, authenticated;

-- ---------- Row level security ----------
-- The backend uses the service role key and is not limited by these policies.
-- Apps that talk to Supabase directly with a user's session can only see their own rows.

alter table airports   enable row level security;
alter table zone_fares enable row level security;
alter table drivers    enable row level security;
alter table staff      enable row level security;
alter table bookings   enable row level security;
alter table payments   enable row level security;
alter table audit_log  enable row level security;

drop policy if exists "airports are public" on airports;
create policy "airports are public" on airports for select using (true);

drop policy if exists "fares are public" on zone_fares;
create policy "fares are public" on zone_fares for select using (true);

drop policy if exists "driver reads own profile" on drivers;
create policy "driver reads own profile" on drivers for select using (auth.uid() = id);

drop policy if exists "driver reads own trips" on bookings;
create policy "driver reads own trips" on bookings for select using (auth.uid() = driver_id);

-- No insert/update/delete policies: all writes go through the backend.
-- staff, payments and audit_log have no policies, so they are invisible to app users.

-- ---------- Airports ----------

insert into airports (code, name, city, pickup_note) values
  ('ACC', 'Kotoka International Airport', 'Accra',
   'Terminal 3 arrivals for international flights, Terminal 2 for domestic flights. Your driver waits at the arrivals exit with your name sign.'),
  ('KMS', 'Prempeh I International Airport', 'Kumasi',
   'Arrivals hall exit. Your driver waits at the exit with your name sign.')
on conflict (code) do nothing;

-- ---------- Starting zones (sample values, change before launch) ----------
-- Fixed sedan fare from the airport to each area. SUV x1.5, van x2.2.

insert into zone_fares (zone, airport, label, areas, sedan_ghs) values
  -- Accra: Kotoka International Airport
  ('ACC-A', 'ACC', 'Zone A', array['Airport Residential','Airport City','Cantonments','East Legon','Labone','Roman Ridge','Shiashie'], 150),
  ('ACC-B', 'ACC', 'Zone B', array['Osu','Ridge','Accra Central','Spintex','Dzorwulu','Tesano','Adabraka','Teshie','Nungua','Legon'], 220),
  ('ACC-C', 'ACC', 'Zone C', array['Tema','Madina','Adenta','Kaneshie','Achimota','Dansoman','Lapaz','Haatso','Dome','Sakumono'], 320),
  ('ACC-D', 'ACC', 'Zone D', array['Kasoa','Aburi','Dodowa','Weija','Prampram','Amasaman','Ashaiman','Oyarifa'], 480),
  -- Kumasi: Prempeh I International Airport
  ('KMS-A', 'KMS', 'Zone A', array['Airport Roundabout','Buokrom','Kotei','KNUST','Ayigya','Bomso','Ayeduase','Asokore Mampong'], 100),
  ('KMS-B', 'KMS', 'Zone B', array['Adum','Asafo','Bantama','Ahodwo','Nhyiaeso','Danyame','Asokwa','Oforikrom','Suame','Tafo','Manhyia'], 150),
  ('KMS-C', 'KMS', 'Zone C', array['Santasi','Kwadaso','Atonsu','Kaase','Ahinsan','Abuakwa','Tanoso','Sokoban','Ejisu','Kronum','Pankrono'], 220),
  ('KMS-D', 'KMS', 'Zone D', array['Bekwai','Konongo','Mampong','Offinso','Obuasi','Nkawie'], 400)
on conflict (zone) do nothing;
