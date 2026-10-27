-- Run once in the SQL Editor of an existing board (schema.sql already includes this).
-- Activity now says "X assigned this to Y" when someone assigns a task to another person.
create or replace function public.board_record_task() returns trigger language plpgsql set search_path = public as $$
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
