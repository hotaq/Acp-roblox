-- Run once in the SQL Editor of an existing board, after 003_notes.sql (schema.sql already includes this).
-- Notes can carry an image (text becomes optional then), and notes can be connected by links.
begin;
alter table public.board_notes add column image_id text;
alter table public.board_notes drop constraint board_notes_body_check;
alter table public.board_notes add constraint board_notes_body_check check (char_length(body) <= 500 and (char_length(body) > 0 or image_id is not null));
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
alter table public.board_note_links enable row level security;
revoke all on public.board_note_links from anon, authenticated;
grant all on public.board_note_links to service_role;
commit;
