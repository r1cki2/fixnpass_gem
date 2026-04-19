-- 견적 요청 마감 시각 (최초 견적 요청 시 서버에서 2주 후로 설정)
alter table public.repair_requests
  add column if not exists quote_deadline_at timestamptz;

-- 고객 문의 게시판
create table if not exists public.inquiries (
  id bigint generated always as identity primary key,
  author_id uuid not null,
  title text not null,
  body text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.inquiry_replies (
  id bigint generated always as identity primary key,
  inquiry_id bigint not null references public.inquiries (id) on delete cascade,
  author_id uuid not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists inquiries_created_at_idx on public.inquiries (created_at desc);
create index if not exists inquiry_replies_inquiry_id_idx on public.inquiry_replies (inquiry_id);

-- 첫 화면 팝업(관리자 배포)
create table if not exists public.site_announcements (
  id bigint generated always as identity primary key,
  title text,
  message text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists site_announcements_active_idx on public.site_announcements (is_active, updated_at desc);

-- (선택) 이미 마켓에 올라간 구 데이터에 대략적인 마감일을 채우려면 검토 후 실행:
-- update public.repair_requests
--   set quote_deadline_at = created_at + interval '14 days'
-- where quote_deadline_at is null
--   and status in ('requested','bidding','matched','repairing','completed');
