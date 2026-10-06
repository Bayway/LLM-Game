-- Deriva: one row per room, the whole ship as JSON. Only the `deriva` edge function
-- (service role) reads and writes it; clients never touch the table directly.
create table public.deriva_rooms (
  code text primary key check (code ~ '^DRV-[A-Z0-9]{4}$'),
  state jsonb not null,
  version integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.deriva_rooms is 'Deriva game rooms; written only by the deriva edge function.';

alter table public.deriva_rooms enable row level security;
-- No policies on purpose: anon and authenticated get nothing, the service role bypasses RLS.
revoke all on public.deriva_rooms from anon, authenticated;
