alter table public.admin_roles
  add column if not exists receives_all_event_mails boolean not null default true;
