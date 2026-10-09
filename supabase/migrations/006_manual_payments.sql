-- 006_manual_payments.sql : drivers can pay the GHS 100 subscription directly to Astrovenza
-- (MTN MoMo, Telecel Cash, AirtelTigo Money or bank transfer), upload proof, and staff confirm it.
-- Paystack stays available. Safe to run more than once.

-- ---------- Where drivers send money (edit these rows in Table Editor > payment_accounts) ----------
create table if not exists payment_accounts (
  method          text primary key check (method in ('mtn','telecel','airteltigo','bank')),
  label           text not null,               -- shown to drivers, e.g. "MTN MoMo (merchant)"
  account_name    text not null,               -- the name the driver should see when sending
  account_number  text not null,               -- MoMo number, merchant ID or bank account number
  bank_name       text,                        -- bank only
  branch          text,                        -- bank only
  instructions    text,                        -- optional extra line, e.g. "Use your plate number as the reference"
  active          boolean not null default false,  -- switch on once the real details are filled in
  sort            integer not null default 0,
  updated_at      timestamptz not null default now()
);
insert into payment_accounts (method, label, account_name, account_number, bank_name, branch, sort) values
  ('mtn',        'MTN MoMo',          'ASTROVENZA VENTURES', 'FILL IN', null,      null,      1),
  ('telecel',    'Telecel Cash',      'ASTROVENZA VENTURES', 'FILL IN', null,      null,      2),
  ('airteltigo', 'AirtelTigo Money',  'ASTROVENZA VENTURES', 'FILL IN', null,      null,      3),
  ('bank',       'Bank transfer',     'ASTROVENZA VENTURES', 'FILL IN', 'FILL IN', 'FILL IN', 4)
on conflict (method) do nothing;
alter table payment_accounts enable row level security;   -- read by the server only

-- ---------- Manual payments live in the same payments table as Paystack ones ----------
alter table payments add column if not exists method        text not null default 'paystack';
alter table payments add column if not exists manual_txn_id text;      -- transaction ID from the MoMo/bank message
alter table payments add column if not exists payer_account text;      -- number or account the driver paid from
alter table payments add column if not exists proof_path    text;      -- private storage path of the screenshot
alter table payments add column if not exists reviewed_by   uuid references auth.users(id) on delete set null;
alter table payments add column if not exists reviewed_at   timestamptz;
alter table payments add column if not exists reject_reason text;

alter table payments drop constraint if exists payments_method_check;
alter table payments add constraint payments_method_check
  check (method in ('paystack','mtn','telecel','airteltigo','bank'));
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check
  check (status in ('pending','success','flagged','submitted','rejected'));

-- The same transaction ID can only be claimed once per method (rejected claims don't block a retry).
create unique index if not exists payments_manual_txn_uniq
  on payments (method, upper(manual_txn_id)) where manual_txn_id is not null and status <> 'rejected';
-- One open claim per driver at a time.
create unique index if not exists payments_one_open_claim
  on payments (driver_id) where status = 'submitted';

-- ---------- Staff decision (one transaction) ----------
create or replace function review_manual_payment(
  p_reference text, p_staff uuid, p_approve boolean, p_reason text, p_sub_days integer
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  p payments%rowtype;
begin
  update payments
     set status = case when p_approve then 'success' else 'rejected' end,
         paid_at = case when p_approve then now() else null end,
         reviewed_by = p_staff, reviewed_at = now(),
         reject_reason = case when p_approve then null else p_reason end
   where reference = p_reference and status = 'submitted'
  returning * into p;

  if not found then
    return 'already_handled';
  end if;

  if p_approve then
    update drivers
       set sub_until = greatest(coalesce(sub_until, now()), now()) + make_interval(days => p_sub_days)
     where id = p.driver_id;
    return 'subscription_extended';
  end if;
  return 'rejected';
end;
$$;
revoke all on function review_manual_payment(text, uuid, boolean, text, integer) from public, anon, authenticated;

-- ---------- Private bucket for payment screenshots (staff view them through short-lived links) ----------
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('payment-proofs', 'payment-proofs', false, 3145728, array['image/jpeg','image/png','image/webp'])
    on conflict (id) do nothing;
  end if;
end $$;
