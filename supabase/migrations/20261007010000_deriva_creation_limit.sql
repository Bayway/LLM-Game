-- Deriva: a cap on room creation, per caller (a keyed hash of their IP, never the IP)
-- and overall. Only the deriva edge function (service role) calls it.
create table public.deriva_room_creations (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  created_at timestamptz not null default now()
);

create index deriva_room_creations_ip_hash_created_at_idx
  on public.deriva_room_creations (ip_hash, created_at);
create index deriva_room_creations_created_at_idx
  on public.deriva_room_creations (created_at);

comment on table public.deriva_room_creations is 'Recent Deriva room creations, kept one day for rate limiting.';

alter table public.deriva_room_creations enable row level security;
revoke all on public.deriva_room_creations from anon, authenticated;

-- Claims one room creation for p_ip_hash: 'ok', or the limit that stops it
-- ('hour', 'day', 'overall'). The advisory lock serializes concurrent claims,
-- so two calls can never both slip under a limit.
create function public.deriva_claim_room_creation(p_ip_hash text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  per_caller_hour constant integer := 3;
  per_caller_day constant integer := 10;
  overall_hour constant integer := 50;
begin
  perform pg_advisory_xact_lock(hashtext('deriva_room_creations'));
  delete from public.deriva_room_creations where created_at < now() - interval '1 day';

  if (select count(*) from public.deriva_room_creations
      where ip_hash = p_ip_hash and created_at > now() - interval '1 hour') >= per_caller_hour then
    return 'hour';
  end if;
  if (select count(*) from public.deriva_room_creations where ip_hash = p_ip_hash) >= per_caller_day then
    return 'day';
  end if;
  if (select count(*) from public.deriva_room_creations
      where created_at > now() - interval '1 hour') >= overall_hour then
    return 'overall';
  end if;

  insert into public.deriva_room_creations (ip_hash) values (p_ip_hash);
  return 'ok';
end;
$$;

revoke execute on function public.deriva_claim_room_creation(text) from public, anon, authenticated;
grant execute on function public.deriva_claim_room_creation(text) to service_role;
