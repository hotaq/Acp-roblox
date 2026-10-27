-- Run once in a NEW Supabase project's SQL Editor. One workspace per database/deployment.
begin;

create table public.board_keys (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 60),
  role text not null check (role in ('agent', 'member')),
  key_hash text not null unique,
  prefix text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.board_tasks (
  id uuid primary key default gen_random_uuid(),
  code bigint generated always as identity unique,
  title text not null check (char_length(title) between 1 and 140),
  description text not null default '' check (char_length(description) <= 4000),
  priority text not null default 'medium' check (priority in ('low','medium','high')),
  status text not null default 'todo' check (status in ('todo','in_progress','blocked','done')),
  assignee_id text,
  assignee_name text,
  updated_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.board_activity (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.board_tasks(id),
  task_code bigint,
  kind text not null check (kind in ('created','status','progress','handoff','decision')),
  body text not null check (char_length(body) between 1 and 4000),
  actor text not null,
  created_at timestamptz not null default now()
);

create table public.board_notes (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) <= 500),
  color text not null default 'yellow' check (color in ('yellow','pink','blue','green','orange')),
  x integer not null default 40 check (x between 0 and 3000),
  y integer not null default 40 check (y between 0 and 2000),
  image_id text,
  author_id text not null,
  author_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (char_length(body) > 0 or image_id is not null)
);

create table public.board_note_links (
  id uuid primary key default gen_random_uuid(),
  from_id uuid not null references public.board_notes(id) on delete cascade,
  to_id uuid not null references public.board_notes(id) on delete cascade,
  label text not null default '' check (char_length(label) <= 60),
  created_by_id text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (from_id, to_id),
  check (from_id <> to_id)
);

create index on public.board_tasks (updated_at desc);
create index on public.board_activity (created_at desc);

create function public.board_touch_task() returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create function public.board_record_task() returns trigger language plpgsql set search_path = public as $$
declare message text;
begin
  if tg_op = 'INSERT' then
    message := 'Created “' || new.title || '”';
  elsif old.assignee_id is distinct from new.assignee_id and new.assignee_id is not null then
    message := case when new.assignee_name = new.updated_by then new.assignee_name || ' claimed this task'
      else new.updated_by || ' assigned this to ' || new.assignee_name end;
  elsif old.assignee_id is distinct from new.assignee_id then
    message := 'Released this task to the backlog';
  else
    message := 'Moved to ' || replace(new.status, '_', ' ');
  end if;
  insert into public.board_activity(task_id,task_code,kind,body,actor)
    values (new.id,new.code,case when tg_op='INSERT' then 'created' else 'status' end,message,new.updated_by);
  return new;
end;
$$;

create trigger board_task_touch before update on public.board_tasks for each row execute function public.board_touch_task();
create trigger board_task_activity after insert or update on public.board_tasks for each row execute function public.board_record_task();

alter table public.board_keys enable row level security;
alter table public.board_tasks enable row level security;
alter table public.board_activity enable row level security;
alter table public.board_notes enable row level security;
alter table public.board_note_links enable row level security;
-- The backend authenticates project access keys. No direct public/browser database access.
revoke all on public.board_keys, public.board_tasks, public.board_activity, public.board_notes, public.board_note_links from anon, authenticated;
grant all on public.board_keys, public.board_tasks, public.board_activity, public.board_notes, public.board_note_links to service_role;
grant usage, select on sequence public.board_tasks_code_seq to service_role;
revoke all on function public.board_touch_task(), public.board_record_task() from public;
grant execute on function public.board_touch_task(), public.board_record_task() to service_role;
commit;
