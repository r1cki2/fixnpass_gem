create table if not exists public.admin_roles (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  granted_by text,
  created_at timestamptz not null default now()
);

alter table public.repair_requests
  add column if not exists is_hidden boolean not null default false;
