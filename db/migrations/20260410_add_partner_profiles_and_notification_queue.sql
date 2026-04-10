create table if not exists public.partner_profiles (
  partner_id uuid primary key references public.profiles(id) on delete cascade,
  business_location text default '',
  service_regions text[] not null default '{}',
  years_experience integer,
  employee_count integer,
  intro text default '',
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_queue (
  notification_id bigserial primary key,
  event_type text not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create index if not exists idx_notification_queue_status_created_at
  on public.notification_queue(status, created_at desc);
