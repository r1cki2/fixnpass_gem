-- 최종견적/내방 정보 1회 저장 후 수정 금지
alter table public.bids
  add column if not exists contractor_progress_locked_at timestamptz;

alter table public.bids
  add column if not exists requester_progress_locked_at timestamptz;
