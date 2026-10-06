-- Deriva: rooms nobody has touched for 30 days are deleted every night.
-- updated_at moves on every write the edge function makes: a join, an action, a signal,
-- a waiting player's presence beat, and a checkpoint when a read ran the ship 30 minutes on.
create index deriva_rooms_updated_at_idx on public.deriva_rooms (updated_at);

-- Deletes the rooms idle for p_days or more and returns how many went.
create function public.deriva_delete_abandoned_rooms(p_days integer default 30)
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.deriva_rooms
    where updated_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*)::integer from gone;
$$;

revoke execute on function public.deriva_delete_abandoned_rooms(integer) from public, anon, authenticated;
grant execute on function public.deriva_delete_abandoned_rooms(integer) to service_role;

create extension if not exists pg_cron with schema pg_catalog;

-- Every night at 03:17 UTC, a quiet hour away from the top of the hour.
select cron.schedule('deriva-delete-abandoned-rooms', '17 3 * * *', 'select public.deriva_delete_abandoned_rooms()');
