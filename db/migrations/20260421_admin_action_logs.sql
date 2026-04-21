create table if not exists public.admin_action_logs (
  id bigint generated always as identity primary key,
  action text not null,
  admin_email text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_action_logs_created_at
  on public.admin_action_logs (created_at desc);
