-- 게스트 PDF 분석: draft 건은 requester_id 없이 저장
alter table public.repair_requests
  alter column requester_id drop not null;

-- 문의 스레드: 관리자 답변 후 의뢰인/업체 추가 문의
create table if not exists public.inquiry_followups (
  id bigint generated always as identity primary key,
  inquiry_id bigint not null references public.inquiries (id) on delete cascade,
  author_id uuid not null,
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists inquiry_followups_inquiry_idx on public.inquiry_followups (inquiry_id);

-- 관리자 답변 식별(목록에서 답변전/완료 집계용) 및 수정 시각
alter table public.inquiry_replies
  add column if not exists is_staff boolean not null default false;

alter table public.inquiry_replies
  add column if not exists updated_at timestamptz;
