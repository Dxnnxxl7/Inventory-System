-- Stored / Subscription setup for Supabase + PayPal or Stripe
-- Run this AFTER supabase-security.sql.
--
-- What this adds:
-- 1) Billing fields on establishments.
-- 2) A private billing_events audit table for payment webhook history.
-- 3) RLS rules so owners can read their own billing status.
-- 4) Helper functions the app can call to decide whether a business is active.
--
-- Never put your PayPal/Stripe secret keys or webhook secrets in this SQL file.
-- Those belong in Vercel environment variables only.

create extension if not exists pgcrypto;

alter table public.establishments
  add column if not exists subscription_status text not null default 'trialing',
  add column if not exists plan text not null default 'trial',
  add column if not exists trial_ends_at timestamptz,
  add column if not exists current_period_end timestamptz,
  add column if not exists payment_provider text not null default 'manual',
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists paypal_subscription_id text,
  add column if not exists paypal_plan_id text,
  add column if not exists paypal_payer_id text,
  add column if not exists billing_email text,
  add column if not exists billing_updated_at timestamptz not null default now();

alter table public.establishments
  drop constraint if exists establishments_subscription_status_check;

alter table public.establishments
  add constraint establishments_subscription_status_check
  check (subscription_status in (
    'trialing',
    'active',
    'past_due',
    'canceled',
    'unpaid',
    'incomplete',
    'incomplete_expired',
    'paused'
  ));

alter table public.establishments
  drop constraint if exists establishments_plan_check;

alter table public.establishments
  add constraint establishments_plan_check
  check (plan in ('trial','starter','pro','multi_branch','manual'));

create index if not exists establishments_stripe_customer_idx
  on public.establishments(stripe_customer_id);

create unique index if not exists establishments_stripe_checkout_session_idx
  on public.establishments(stripe_checkout_session_id)
  where stripe_checkout_session_id is not null;

create index if not exists establishments_stripe_subscription_idx
  on public.establishments(stripe_subscription_id);

create unique index if not exists establishments_paypal_subscription_idx
  on public.establishments(paypal_subscription_id)
  where paypal_subscription_id is not null;

create index if not exists establishments_payment_provider_idx
  on public.establishments(payment_provider);

create table if not exists public.billing_events (
  id uuid primary key default gen_random_uuid(),
  stripe_event_id text unique not null,
  paypal_event_id text unique,
  payment_provider text not null default 'stripe',
  event_type text not null,
  establishment_id text references public.establishments(id) on delete set null,
  stripe_customer_id text,
  stripe_subscription_id text,
  paypal_subscription_id text,
  payload jsonb not null default '{}'::jsonb,
  processed_at timestamptz not null default now()
);

alter table public.billing_events
  alter column stripe_event_id drop not null,
  add column if not exists paypal_event_id text,
  add column if not exists payment_provider text not null default 'stripe',
  add column if not exists paypal_subscription_id text;

create unique index if not exists billing_events_paypal_event_idx
  on public.billing_events(paypal_event_id)
  where paypal_event_id is not null;

alter table public.billing_events enable row level security;

drop policy if exists billing_events_owner_select on public.billing_events;
drop policy if exists billing_events_service_only_insert on public.billing_events;

create policy billing_events_owner_select
on public.billing_events
for select
to authenticated
using (
  establishment_id is not null
  and public.is_establishment_owner(establishment_id)
);

-- Insert/update/delete billing_events from your Vercel webhook using the Supabase
-- service role key. Service role bypasses RLS, so normal users do not need insert.
revoke all on public.billing_events from anon, authenticated;
grant select on public.billing_events to authenticated;

-- True means the business may use the paid app.
-- This is intentionally stricter than "not canceled".
create or replace function public.establishment_has_active_access(est_id text)
returns boolean
language sql
security definer
set search_path = public
set row_security = off
stable
as $$
  select exists (
    select 1
    from public.establishments e
    where e.id = est_id
      and (
        e.subscription_status = 'active'
        or (
          e.subscription_status = 'trialing'
          and (e.trial_ends_at is null or e.trial_ends_at > now())
        )
      )
  );
$$;

-- Safe billing summary for the logged-in owner/staff.
-- Staff can see whether the business is active; only owners should manage billing
-- through the payment provider route in Vercel.
create or replace function public.my_establishment_access(est_id text)
returns table (
  establishment_id text,
  subscription_status text,
  plan text,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  has_active_access boolean,
  is_owner boolean,
  is_staff boolean
)
language sql
security definer
set search_path = public
set row_security = off
stable
as $$
  select
    e.id,
    e.subscription_status,
    e.plan,
    e.trial_ends_at,
    e.current_period_end,
    public.establishment_has_active_access(e.id),
    public.is_establishment_owner(e.id),
    public.is_approved_staff(e.id)
  from public.establishments e
  where e.id = est_id
    and (
      public.is_establishment_owner(e.id)
      or public.is_approved_staff(e.id)
    );
$$;

grant execute on function public.establishment_has_active_access(text) to authenticated;
grant execute on function public.my_establishment_access(text) to authenticated;

-- Optional: give every existing business a 14-day trial if it does not already
-- have a trial end date. Comment this out if you want to manually control access.
update public.establishments
set trial_ends_at = coalesce(trial_ends_at, now() + interval '14 days'),
    subscription_status = case
      when subscription_status in ('active','past_due','canceled','unpaid') then subscription_status
      else 'trialing'
    end,
    billing_updated_at = now()
where trial_ends_at is null
  and stripe_subscription_id is null
  and paypal_subscription_id is null;

-- Webhook update pattern for Vercel:
--
-- On checkout.session.completed:
-- update establishments
-- set stripe_customer_id = :customer,
--     stripe_checkout_session_id = :checkout_session,
--     stripe_subscription_id = :subscription,
--     subscription_status = 'active',
--     plan = :plan,
--     billing_email = :email,
--     billing_updated_at = now()
-- where id = :establishment_id;
--
-- On customer.subscription.updated/deleted:
-- update establishments
-- set subscription_status = :stripe_status,
--     current_period_end = to_timestamp(:current_period_end),
--     billing_updated_at = now()
-- where stripe_subscription_id = :subscription;
--
-- PayPal owner creation inserts:
-- payment_provider = 'paypal',
-- paypal_subscription_id = :subscription,
-- paypal_plan_id = :plan,
-- paypal_payer_id = :payer,
-- subscription_status = 'active'
