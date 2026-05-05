# Fix&Pass 인수인계 개요 (웹 · 백엔드 · DB)

본 문서는 외주 운영사 인수 시 **페이지 구조, 주요 사용자 흐름, 백엔드 API, DB 마이그레이션**을 한눈에 파악하기 위한 요약입니다. 세부 로직은 `fix-n-pass-web/` 및 `main.py`를 기준으로 합니다.

---

## 1. 시스템 구성

| 구분 | 스택 · 위치 |
|------|----------------|
| 프론트엔드 | Next.js (App Router), `fix-n-pass-web/` |
| 백엔드 API | FastAPI 단일 앱 `main.py` (루트) |
| 인증 | Supabase Auth (클라이언트: `@supabase/supabase-js`, 세션은 `sessionStorage` 커스텀 어댑터) |
| DB · Storage | Supabase (PostgreSQL, Storage 버킷: 원본·마스킹 PDF 등 — 코드 내 버킷명 참조) |
| AI 분석 | Google Gemini (`GEMINI_API_KEY`) |
| 메일 | SMTP 환경변수 (`MAIL_SMTP_*`), 알림 큐 `notification_queue` + 선택적 즉시 발송 |

환경변수는 프론트 `NEXT_PUBLIC_*`, 서버 `SUPABASE_*`, `GEMINI_*`, SMTP 등 분리되어 있습니다.

---

## 2. 웹 페이지 목록 · 역할

공통: 루트 `layout.tsx` — 상단 고정 헤더(로고, 내 요청 내역, 마이페이지, 수리 마켓, 고객 문의), `AuthNav`, `SiteAnnouncementModal`.

| 경로 | 대상 | 요약 |
|------|------|------|
| `/` | 의뢰인·비회원 | PDF 업로드 → Gemini 분석 → 부적합/권고 항목 선택 → 견적 요청(`update-request`). 비회원 시 `localStorage`에 pending 저장 후 로그인 유도 |
| `/login` | 전체 | 로그인. `next` 쿼리 지원. 로그인 후 `submitPendingQuoteRequest` 성공 시 `/my-requests`로 이동 |
| `/signup` | 전체 | 회원가입 → 프로필 API. 의뢰인 완료 후 pending 있으면 `/my-requests` |
| `/onboarding` | 신규 | 역할·프로필 미완료 시 유도 |
| `/my-requests` | 의뢰인 | 요청 목록, pending 견적 자동 제출 시도 |
| `/my-requests/[id]` | 의뢰인 | 상세: 선택 항목(부적합/권고 구분), 견적 카드, 체크박스 최대 2개 선정 → 매칭, 선정 업체 정보·의뢰인 확인 필드 |
| `/my-page` | 로그인 사용자 | 마이페이지 |
| `/contractor/market` | 수리업체 | 마켓 목록. 비활성/미승인 시 목록 대신 안내 카드 |
| `/contractor/market/[id]` | 수리업체 | 상세: 현장 정보, 수리 항목, 마스킹 PDF, 견적 입력·수정. **매칭·선정 후** 의뢰인 연락처·주소 노출 + 최종 견적·내방 정보 제출 |
| `/partner/[id]` | 의뢰인 등 | 업체 공개 프로필. `?request_id=` + Bearer 시 매칭 전 마스킹 규칙 적용 |
| `/inquiry` | 전체 | 문의 목록 |
| `/inquiry/new` | 로그인 | 문의 작성 |
| `/inquiry/[id]` | 전체 | 문의 상세 |
| `/admin` | 관리자 | 사용자·요청·설정·팝업·문의 등 운영 |

역할별 클라이언트 분기: 여러 페이지에서 `profiles.role`으로 업체·의뢰인 접근 차단 또는 리다이렉트.

---

## 3. 주요 페이지 전환 · “알고리즘” (비즈니스 흐름)

### 3.1 게스트 PDF → 로그인 후 견적 요청

1. `/` 에서 분석 완료 후 견적 요청 클릭.
2. 미로그인: `savePendingQuoteRequest` → `/login?next=/my-requests` (또는 동등 경로).
3. 로그인 성공 시 `submitPendingQuoteRequest(userId)` → `POST /api/update-request` (`status: requested`).
4. 성공 시 pending 삭제 → 라우팅 `/my-requests` (로그인·회원가입 페이지 로직 포함).

### 3.2 의뢰인 요청 라이프사이클 (상태)

`repair_requests.status` 예시 흐름:

- `draft`: 게스트 업로드만 된 임시 건 (`requester_id` 없을 수 있음).
- `requested` → 업체 입찰 시작 시 `bidding`.
- 의뢰인이 `POST /api/match-partners`로 `selected_bid_ids`(최대 2개) 제출 시 `matched`, `contact_unlocked_at` 설정.
- 이후 운영 정의에 따라 `repairing`, `completed`, `cancelled` 등.

**중복 PDF 방지**: 동일 문서 지문(`parsed_data.document_fingerprint`)은 `requested|bidding|matched|repairing|completed` 이고 마감 전인 건만 검사 — **`draft`는 제외** (추가 분석 허용).

### 3.3 수리업체 마켓 접근

1. 로그인 필수, `profiles.role === contractor`.
2. `_require_active_role`: 비활성(`is_active=false`)이면 목록 API 403 → 프론트에서 큰 안내 카드.
3. 목록은 관심 지역 등 필터와 함께 `GET /api/contractor/market`.

### 3.4 견적 제출 · 수정

- `POST /api/contractor/bid`: 최초 등록 또는 `edit_count` 1회 수정까지 (매칭 후 불가 등 규칙은 코드 참조).

### 3.5 매칭 후 연락처 · 마스킹

- 의뢰인 견적 목록 API에서 상태·선정 여부에 따라 업체명·전화 마스킹.
- 업체 상세 `GET /api/partner/{id}?request_id=` + JWT: 매칭 전/비선정 시 마스킹.

### 3.6 매칭 후 현장 방문 · 최종 견적

- 업체: `POST /api/contractor/bids/final-quote` (선정된 bid만).
- 의뢰인: `POST /api/my-requests/{rid}/bids/{bid_id}/requester-fields` (선정 bid만).

컬럼은 `db/migrations/20260502_bid_site_visit_and_final_quote.sql` 참조.

---

## 4. 백엔드 API 목록 (요약)

모두 `main.py` 기준 경로입니다.

### 핵심 비즈니스

| 메서드 | 경로 | 설명 |
|--------|------|------|
| POST | `/api/upload-pdf` | PDF 업로드, Gemini 분석, Storage 저장, `repair_requests` 생성(보통 `draft`) |
| POST | `/api/update-request` | 의뢰인 연결·항목·`requested` 등 갱신, 알림 큐 |
| POST | `/api/pending-quote/discard-draft` | 업체가 게스트 draft 정리 등 |
| POST | `/api/contractor/bid` | 견적 등록·수정 |
| POST | `/api/match-partners` | 선정 bid 최대 2개 → `matched` |
| POST | `/api/contractor/bids/final-quote` | 업체 최종 견적·내방 정보 |
| POST | `/api/my-requests/{rid}/bids/{bid_id}/requester-fields` | 의뢰인 확인 입력 |

### 의뢰인 · 업체 정보

| 메서드 | 경로 |
|--------|------|
| GET | `/api/my-requests`, `/api/my-requests/{id}`, `/api/my-requests/{id}/bids` |
| POST | `/api/my-requests/{id}/cancel` |
| GET | `/api/contractor/market`, `/api/contractor/market/{id}` |
| GET | `/api/requests/{id}/pdf` |
| GET | `/api/partner/{partner_id}` |

### 프로필 · 설정

| 메서드 | 경로 |
|--------|------|
| GET/POST | `/api/me/profile` |
| GET | `/api/signup-config`, `/api/regions/recommend`, `/api/regions/open-demand` |

### 고객 문의

| 메서드 | 경로 |
|--------|------|
| GET | `/api/inquiries`, `/api/inquiries/{id}` |
| POST | `/api/inquiries`, `/api/inquiries/{id}/reply`, `/api/inquiries/{id}/followup` |
| PATCH | `/api/admin/inquiry-replies/{reply_id}` |

### 관리자 (Bearer + `MASTER_ADMIN_EMAIL` / `admin_roles`)

- `/api/admin/session`, `/api/admin/users`, `/api/admin/auth-users`, 비밀번호·삭제·벌크
- `/api/admin/requests`, 상태·매칭·벌크
- `/api/admin/settings/contractor-approval`, `/api/admin/site-announcements*`, `/api/admin/overview`, `/api/admin/action-logs`, 통계 등

### 기타

- `GET /api/site-announcement` — 로그인 전 팝업
- `POST /api/notifications/process` — 알림 큐 처리(크론 등)

---

## 5. DB 마이그레이션 파일 (repo 기준)

`db/migrations/`:

- `20260410_add_partner_profiles_and_notification_queue.sql` — `partner_profiles`, `notification_queue`
- `20260410_add_profiles_is_active.sql`
- `20260419_ui_features.sql`
- `20260420_guest_requester_and_inquiry_followup.sql`
- `20260421_contractor_signup_approval_setting.sql`
- `20260421_admin_action_logs.sql`
- `20260421_admin_bulk_and_phone_fields.sql`
- `20260422_admin_roles_and_request_privacy.sql`
- `20260502_bid_site_visit_and_final_quote.sql` — `bids` 확장

**운영 시**: Supabase SQL Editor에서 순서·누락 여부 확인 후 적용. 실제 테이블이 스키마보다 앞서 생성된 초기 세팅이 있을 수 있으니 프로덕션과 diff 검증 필요.

---

## 6. 프론트 공통 라이브러리 · 컴포넌트

- `lib/supabase.ts` — 브라우저 `sessionStorage` 세션 저장
- `lib/pendingQuote.ts` — 게스트 pending 견적
- `components/AuthNav.tsx` — 세션 + 관리자 링크(`/api/admin/session`)
- `components/SiteAnnouncementModal.tsx`
- 검증·주소 등 `lib/validation.ts`, `components/AddressSearchInput.tsx` 등

---

## 7. 배포 시 체크리스트 (외주 인계용)

1. **Supabase**: 모든 마이그레이션 적용, RLS·서비스 롤 키 서버 전용 사용.
2. **Render(또는 호스트)**: FastAPI 서비스 + Next 빌드, 환경변수 동기화.
3. **Storage**: 업로드 버킷 권한 및 CORS.
4. **도메인**: `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_*`.
5. **SMTP**: 미설정 시 큐 적재만 되고 즉시 메일 생략 가능(코드 동작 확인).

---

## 8. 문서 유지보수

기능 추가 시 다음을 갱신하는 것을 권장합니다.

- 본 파일의 **페이지 표 · API 표 · 상태 흐름**
- 새 마이그레이션 파일명과 목적
- 운영 전용 환경변수 목록 (별도 시크릿 문서와 분리 관리)

---

*생성 기준: 저장소 내 소스 및 마이그레이션 목록. 세부 검증은 반드시 스테이징에서 동선 테스트를 수행하세요.*
