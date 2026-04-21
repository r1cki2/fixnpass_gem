create table if not exists public.app_settings (
  key text primary key,
  value_json jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value_json)
values ('contractor_signup', '{"require_approval": true}'::jsonb)
on conflict (key) do nothing;
