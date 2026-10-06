-- Deriva: a cap on join attempts per caller (a keyed hash of their IP), wrong codes included,
-- so room codes cannot be guessed by trying them. 20 an hour leaves room for a whole team
-- joining from one office network, typos and all. No overall cap: one would let anyone with
-- many addresses lock every other player out.
create table public.deriva_join_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index deriva_join_attempts_ip_hash_created_at_idx
  on public.deriva_join_attempts (ip_hash, created_at);
create index deriva_join_attempts_created_at_idx
  on public.deriva_join_attempts (created_at);

comment on table public.deriva_join_attempts is 'Recent Deriva join attempts, kept one hour for rate limiting.';

alter table public.deriva_join_attempts enable row level security;
revoke all on public.deriva_join_attempts from anon, authenticated;

-- Claims one join attempt for p_ip_hash: 'ok', or 'hour' when the caller is over the limit.
-- The advisory lock serializes concurrent claims, as deriva_claim_room_creation does.
create function public.deriva_claim_join_attempt(p_ip_hash text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  per_caller_hour constant integer := 20;
begin
  perform pg_advisory_xact_lock(hashtext('deriva_join_attempts'));
  delete from public.deriva_join_attempts where created_at < now() - interval '1 hour';

  if (select count(*) from public.deriva_join_attempts where ip_hash = p_ip_hash) >= per_caller_hour then
    return 'hour';
  end if;

  insert into public.deriva_join_attempts (ip_hash) values (p_ip_hash);
  return 'ok';
end;
$$;

revoke execute on function public.deriva_claim_join_attempt(text) from public, anon, authenticated;
grant execute on function public.deriva_claim_join_attempt(text) to service_role;
