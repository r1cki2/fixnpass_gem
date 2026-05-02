-- 업체: 현장 내방·최종 견적 고지 / 의뢰인: 동일 건에 대한 확인·후기
alter table public.bids add column if not exists site_visit_date date;
alter table public.bids add column if not exists final_bid_amount bigint;
alter table public.bids add column if not exists variance_reason text;
alter table public.bids add column if not exists contractor_extra_note text;

alter table public.bids add column if not exists requester_site_visit_date date;
alter table public.bids add column if not exists requester_final_bid_amount bigint;
alter table public.bids add column if not exists requester_variance_note text;
alter table public.bids add column if not exists requester_visit_review text;

alter table public.bids add column if not exists bid_progress_updated_at timestamptz;

comment on column public.bids.site_visit_date is '업체 입력: 최종견적 산정용 현장 내방 일자';
comment on column public.bids.final_bid_amount is '업체 입력: 최종 견적액(원)';
comment on column public.bids.variance_reason is '업체 입력: 최초 견적액 대비 변동 사유';
comment on column public.bids.contractor_extra_note is '업체 선택: 현장 내방 후기 및 기타 의견';

comment on column public.bids.requester_site_visit_date is '의뢰인 입력: 현장 내방 일자(확인)';
comment on column public.bids.requester_final_bid_amount is '의뢰인 입력: 최종 견적액(확인)';
comment on column public.bids.requester_variance_note is '의뢰인 선택: 변동 사유 메모';
comment on column public.bids.requester_visit_review is '의뢰인 선택: 업체 현장 내방 후기';
