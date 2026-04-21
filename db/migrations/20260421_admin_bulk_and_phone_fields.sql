alter table public.profiles
  add column if not exists office_phone_number text;

create table if not exists public.admin_user_deletion_archive (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  email text,
  role text,
  company_name text,
  requested_by text not null,
  requested_at timestamptz not null default now()
);

create index if not exists idx_admin_user_deletion_archive_user_id
  on public.admin_user_deletion_archive (user_id);
