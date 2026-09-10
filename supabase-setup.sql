-- Run this once in Supabase → SQL Editor.
-- One table holds every collection the app uses (settings, bookings,
-- partners, vehicles, customers, reviews, support, counter) as a JSON
-- value per key — this matches the app's existing data shape exactly,
-- so no other code changes are needed beyond swapping the storage functions.

create table if not exists app_data (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table app_data enable row level security;

-- NOTE: these policies allow anyone with your anon key (i.e. anyone who
-- visits your site) to read and write this table. That matches the
-- security level this app already had (client-side only, no server-side
-- auth) — see README.md → "Security checklist before launch" for what a
-- real production version needs (server-side auth, RLS scoped to a real
-- user id, etc). This is fine for getting the site genuinely working and
-- shared across devices right now.

create policy "public can read app_data"
  on app_data for select
  using (true);

create policy "public can insert app_data"
  on app_data for insert
  with check (true);

create policy "public can update app_data"
  on app_data for update
  using (true)
  with check (true);
