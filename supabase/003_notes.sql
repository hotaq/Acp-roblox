-- Run once in the SQL Editor of an existing board (schema.sql already includes this). Adds the idea board's notes.
begin;
create table public.board_notes (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) between 1 and 500),
  color text not null default 'yellow' check (color in ('yellow','pink','blue','green','orange')),
  x integer not null default 40 check (x between 0 and 3000),
  y integer not null default 40 check (y between 0 and 2000),
  author_id text not null,
  author_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.board_notes enable row level security;
revoke all on public.board_notes from anon, authenticated;
grant all on public.board_notes to service_role;
commit;
