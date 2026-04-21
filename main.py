import functools
import json
import logging
import smtplib
import os
import re
from collections import defaultdict
import tempfile
import uuid
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from typing import List, Optional

import fitz
import httpx
from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")  # fallback (legacy)
SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SECRET_KEY")
    or os.environ.get("SERVICE_ROLE_KEY")
)
SUPABASE_SERVER_KEY = SUPABASE_SERVICE_ROLE_KEY or SUPABASE_KEY
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVER_KEY)
ADMIN_EMAIL = os.environ.get("ADMIN_EMAIL", "").strip().lower()
MAIL_SMTP_HOST = os.environ.get("MAIL_SMTP_HOST", "")
MAIL_SMTP_PORT = int(os.environ.get("MAIL_SMTP_PORT", "587"))
MAIL_SMTP_USER = os.environ.get("MAIL_SMTP_USER", "")
MAIL_SMTP_PASS = os.environ.get("MAIL_SMTP_PASS", "")
MAIL_FROM = os.environ.get("MAIL_FROM", MAIL_SMTP_USER or "no-reply@fixnpass.local")
MAIL_CRON_SECRET = (
    os.environ.get("MAIL_CRON_SECRET") or os.environ.get("NOTIFICATION_CRON_SECRET") or ""
).strip()

ORIGINAL_BUCKET = "inspection-original"
MASKED_BUCKET = "inspection-masked"

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
)


def _key_kind(key: Optional[str]) -> str:
    if not key:
        return "missing"
    if "service_role" in key:
        return "service_role"
    if "anon" in key:
        return "anon"
    return "unknown"


RATE_LIMITS = {
    "upload_pdf": {"limit": 10, "window_sec": 60},
    "update_request": {"limit": 20, "window_sec": 60},
    "submit_bid": {"limit": 20, "window_sec": 60},
    "match_partners": {"limit": 10, "window_sec": 60},
    "inquiry_create": {"limit": 15, "window_sec": 120},
    "inquiry_followup": {"limit": 20, "window_sec": 120},
}
_rate_counters: dict[str, List[datetime]] = {}


def _rate_limit(endpoint: str, actor: str):
    cfg = RATE_LIMITS.get(endpoint)
    if not cfg:
        return
    now = datetime.utcnow()
    key = f"{endpoint}:{actor}"
    window_start = now.timestamp() - cfg["window_sec"]
    current = _rate_counters.get(key, [])
    filtered = [t for t in current if t.timestamp() >= window_start]
    if len(filtered) >= cfg["limit"]:
        raise HTTPException(status_code=429, detail="요청이 너무 많습니다. 잠시 후 다시 시도해주세요.")
    filtered.append(now)
    _rate_counters[key] = filtered


def _log_admin_action(action: str, admin_email: str, payload: dict):
    logging.info(
        "[admin-action] action=%s admin=%s payload=%s",
        action,
        admin_email,
        json.dumps(payload, ensure_ascii=False),
    )
    try:
        supabase.table("admin_action_logs").insert(
            {
                "action": action,
                "admin_email": admin_email,
                "payload": payload,
            }
        ).execute()
    except Exception:
        pass


def _extract_bearer(authorization: Optional[str]) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="인증 토큰이 필요합니다.")
    return authorization.replace("Bearer ", "", 1).strip()


def _require_admin(authorization: Optional[str]) -> dict:
    if not ADMIN_EMAIL:
        raise HTTPException(status_code=500, detail="서버에 ADMIN_EMAIL 설정이 필요합니다.")
    token = _extract_bearer(authorization)
    user_res = supabase.auth.get_user(token)
    user = getattr(user_res, "user", None)
    if not user or not user.email:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")
    email = user.email.lower()
    if email != ADMIN_EMAIL:
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")
    return {"id": user.id, "email": email}


def _require_authenticated_user(authorization: Optional[str]) -> dict:
    token = _extract_bearer(authorization)
    user_res = supabase.auth.get_user(token)
    user = getattr(user_res, "user", None)
    if not user or not user.id:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다.")
    return {"id": user.id, "email": (user.email or "").lower()}


class UpdateRequest(BaseModel):
    repair_request_id: int
    requester_id: str
    selected_items: list
    status: str = "requested"


class BidSubmission(BaseModel):
    repair_request_id: int
    partner_id: str
    bid_amount: int


class MatchPartners(BaseModel):
    repair_request_id: int
    requester_id: str
    selected_bid_ids: List[int]


class AdminUserRoleUpdate(BaseModel):
    role: str


class AdminRequestStatusUpdate(BaseModel):
    status: str


class AdminRequestMatchUpdate(BaseModel):
    selected_bid_ids: List[int]


class AdminUserActiveUpdate(BaseModel):
    is_active: bool
    force_duplicate_ok: Optional[bool] = False


class AdminUserBulkDeleteBody(BaseModel):
    user_ids: List[str]


class AdminBulkRequestStatusUpdate(BaseModel):
    request_ids: List[int]
    status: str


class InquiryCreate(BaseModel):
    title: str
    body: str


class InquiryReplyCreate(BaseModel):
    body: str


class SiteAnnouncementDeploy(BaseModel):
    title: Optional[str] = None
    message: str


class ContractorApprovalSettingUpdate(BaseModel):
    require_approval: bool


class InquiryFollowupCreate(BaseModel):
    body: str


class InquiryReplyPatch(BaseModel):
    body: str


class AdminPasswordUpdate(BaseModel):
    new_password: str


class AdminDeleteUserBody(BaseModel):
    confirm_email: str


class MyProfileUpdate(BaseModel):
    user_id: str
    role: Optional[str] = None
    name: Optional[str] = None
    phone_number: Optional[str] = None
    office_phone_number: Optional[str] = None
    company_name: Optional[str] = None
    business_location: Optional[str] = None
    service_regions: Optional[List[str]] = None
    years_experience: Optional[int] = None
    employee_count: Optional[int] = None
    trigger_signup_notice: Optional[bool] = False


def _safe_list(v):
    return v if isinstance(v, list) else []


def _normalize_phone(value: Optional[str]) -> str:
    return re.sub(r"[^0-9]", "", value or "")


def _is_contractor_approval_required() -> bool:
    try:
        row = (
            supabase.table("app_settings")
            .select("value_json")
            .eq("key", "contractor_signup")
            .limit(1)
            .execute()
        )
        if not row.data:
            return True
        v = row.data[0].get("value_json") or {}
        return bool(v.get("require_approval", True))
    except Exception:
        return True


def _set_contractor_approval_required(value: bool):
    supabase.table("app_settings").upsert(
        {
            "key": "contractor_signup",
            "value_json": {"require_approval": bool(value)},
            "updated_at": datetime.utcnow().isoformat(),
        }
    ).execute()


def _get_profile(user_id: str) -> Optional[dict]:
    try:
        profile_res = (
            supabase.table("profiles")
            .select("role, is_active, name, phone_number, office_phone_number, company_name")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
    except Exception:
        # Backward compatibility when is_active column is not created yet.
        profile_res = (
            supabase.table("profiles")
            .select("role, name, phone_number, office_phone_number, company_name")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
    if not profile_res.data:
        return None
    profile = profile_res.data[0]
    if "is_active" not in profile:
        profile["is_active"] = True
    return profile


def _require_active_role(user_id: str, allowed_roles: List[str], who: str):
    profile = _get_profile(user_id)
    if not profile:
        raise HTTPException(status_code=403, detail=f"{who} 프로필이 없습니다.")
    if profile.get("role") not in allowed_roles:
        role_kr = "수리업체" if "contractor" in allowed_roles else "의뢰인"
        raise HTTPException(status_code=403, detail=f"{role_kr}만 접근할 수 있습니다.")
    if not profile.get("is_active", True):
        raise HTTPException(status_code=403, detail="비활성화된 계정입니다. 관리자에게 문의해주세요.")


def _enqueue_notification(event_type: str, user_id: str, payload: dict):
    try:
        supabase.table("notification_queue").insert(
            {
                "event_type": event_type,
                "user_id": user_id,
                "payload": payload,
                "status": "pending",
            }
        ).execute()
    except Exception as e:
        logging.warning("notification_queue insert failed: %s", str(e))


def _site_alias(request_id: int) -> str:
    token = hex((request_id * 2654435761) & 0xFFFFF)[2:].upper()
    return f"현장-{token.zfill(5)}"


def _request_stage_kr(status: str) -> str:
    mapping = {
        "draft": "작성중",
        "requested": "신규요청(견적 대기)",
        "bidding": "견적 진행중",
        "matched": "업체 선정 완료",
        "repairing": "현장 진행중",
        "completed": "작업 완료",
        "cancelled": "취소됨",
    }
    return mapping.get(status, status)


def _send_mail(to_email: str, subject: str, body: str):
    if not (MAIL_SMTP_HOST and MAIL_SMTP_USER and MAIL_SMTP_PASS):
        raise RuntimeError("SMTP env is not configured")
    msg = MIMEText(body, _charset="utf-8")
    msg["Subject"] = subject
    msg["From"] = MAIL_FROM
    msg["To"] = to_email
    with smtplib.SMTP(MAIL_SMTP_HOST, MAIL_SMTP_PORT, timeout=20) as smtp:
        smtp.starttls()
        smtp.login(MAIL_SMTP_USER, MAIL_SMTP_PASS)
        smtp.send_message(msg)


def _normalize_region_summary(address_text: str) -> str:
    """
    주소 문자열에서 시/도 + 시/군/구까지만 추출한다.
    """
    text = (address_text or "").strip()
    if not text:
        return ""
    parts = [p for p in re.split(r"\s+", text) if p]
    if len(parts) >= 2:
        return f"{parts[0]} {parts[1]}"
    return parts[0]


def _enqueue_and_maybe_send(event_type: str, user_id: str, payload: dict):
    try:
        inserted = (
            supabase.table("notification_queue")
            .insert(
                {
                    "event_type": event_type,
                    "user_id": user_id,
                    "payload": payload,
                    "status": "pending",
                }
            )
            .execute()
        )
        n_id = inserted.data[0]["notification_id"] if inserted.data else None
    except Exception as e:
        logging.warning("notification_queue insert failed: %s", str(e))
        return

    if not (MAIL_SMTP_HOST and MAIL_SMTP_USER and MAIL_SMTP_PASS):
        return

    try:
        auth_user = supabase.auth.admin.get_user_by_id(user_id)
        email = getattr(getattr(auth_user, "user", None), "email", None)
        if not email:
            return
        if event_type == "new_request_in_interest_region":
            subject = "[Fix&Pass] 신규 견적 요청이 등록되었습니다"
            body = (
                "안녕하세요. Fix&Pass 알림입니다.\n\n"
                "관심 지역에 새로운 견적 요청이 등록되었습니다.\n"
                f"- 현장 별칭: {payload.get('site_alias')}\n"
                f"- 요청 ID: {payload.get('repair_request_id')}\n"
                f"- 지역: {payload.get('region_summary')}\n"
                f"- 요청 시각: {payload.get('created_at') or '-'}\n\n"
                "수리 마켓에서 상세 내용을 확인해 주세요."
            )
        elif event_type == "first_bid_submitted":
            subject = "[Fix&Pass] 최초 견적 제출이 접수되었습니다"
            body = (
                "최초 견적 제출이 정상 접수되었습니다.\n\n"
                f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                "의뢰인이 업체를 선택하면 추가 안내 메일이 발송됩니다."
            )
        elif event_type == "requester_selected_partner":
            subject = "[Fix&Pass] 의뢰인이 업체를 선택했습니다"
            body = (
                "축하합니다. 제출하신 견적이 의뢰인에게 선택되었습니다.\n\n"
                f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                f"- 선택된 견적 ID: {payload.get('selected_bid_id')}\n"
                "서비스에서 상세 진행 상태를 확인해주세요."
            )
        elif event_type == "new_bid_for_requester":
            action = payload.get("action") or "created"
            action_kr = "신규 등록" if action == "created" else "수정"
            subject = f"[Fix&Pass] 요청하신 건에 견적이 {action_kr}되었습니다"
            body = (
                "안녕하세요. Fix&Pass 알림입니다.\n\n"
                f"요청하신 수리 건에 견적이 {action_kr}되었습니다.\n"
                f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                f"- 견적 ID: {payload.get('bid_id')}\n"
                f"- 견적 금액: {payload.get('bid_amount')}\n\n"
                "내 요청 내역에서 상세 견적을 확인해 주세요."
            )
        else:
            subject = "[Fix&Pass] 알림"
            body = f"새 알림이 도착했습니다. event_type={event_type}"
        _send_mail(email, subject, body)
        if n_id:
            supabase.table("notification_queue").update({"status": "sent"}).eq("notification_id", n_id).execute()
    except Exception as e:
        logging.warning("immediate mail send failed: %s", str(e))


def _build_masked_pdf(original_pdf_bytes: bytes, ai_data: dict) -> bytes:
    """
    원본 PDF 레이아웃/사진은 유지하고, 민감 텍스트만 가린 업체용 PDF를 생성한다.
    """
    doc = fitz.open(stream=original_pdf_bytes, filetype="pdf")
    full_text = ""
    for p in doc:
        full_text += p.get_text() + "\n"

    sensitive_terms = [
        str(ai_data.get("building_name", "")).strip(),
        str(ai_data.get("region_summary", "")).strip(),
        str(ai_data.get("address_detail", "")).strip(),
    ]
    # 텍스트에서 직접 추출 가능한 개인정보 패턴도 함께 마스킹
    sensitive_terms += re.findall(r"\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b", full_text)
    sensitive_terms += re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", full_text)
    sensitive_terms = [t for t in sensitive_terms if t and len(t) >= 2]
    sensitive_terms = list(dict.fromkeys(sensitive_terms))

    for page in doc:
        redaction_count = 0
        for term in sensitive_terms:
            for rect in page.search_for(term):
                page.add_redact_annot(rect, fill=(1, 1, 1))
                redaction_count += 1
        if redaction_count > 0:
            page.apply_redactions()

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


@app.post("/api/upload-pdf")
async def upload_pdf(requester_id: Optional[str] = None, file: UploadFile = File(...)):
    _rate_limit("upload_pdf", requester_id or "guest")
    if requester_id:
        _require_active_role(requester_id, ["requester"], "requester")
    req_token = str(uuid.uuid4())
    owner_key = requester_id or "guest"
    original_path = f"requester/{owner_key}/{req_token}/original.pdf"
    masked_path = f"request/{req_token}/masked.pdf"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        file_bytes = await file.read()
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        # 1) 원본은 private 버킷에 저장 (public URL 금지)
        supabase.storage.from_(ORIGINAL_BUCKET).upload(
            path=original_path,
            file=file_bytes,
            file_options={"content-type": "application/pdf"},
        )

        # 2) PDF 텍스트 추출(최대 5페이지)
        doc = fitz.open(tmp_path)
        text = "".join([doc.load_page(i).get_text() for i in range(min(5, len(doc)))])
        doc.close()

        prompt = f"""
기계식 주차장 안전검사서에서 다음 정보를 추출해 순수 JSON으로만 응답하세요. 마크다운 기호(```)는 금지합니다.

1. building_name: 건물 이름
2. region_summary: 주소에서 '시/군/구'까지만 (예: 서울시 송파구)
3. address_detail: region_summary를 제외한 나머지 상세 주소 전체
4. parking_type: 기계식 주차장의 기종 및 구동 방식(종류 및 방식) (예: 승강기식 횡식 하부승입식. 없으면 '기종 확인 불가')
5. mandatory_repairs: '부적합' 항목 리스트
6. optional_repairs: '권고' 또는 '주의' 항목 리스트

텍스트: {text[:20000]}
"""
        async with httpx.AsyncClient(timeout=60.0) as client:
            ai_res = await client.post(
                GEMINI_URL, json={"contents": [{"parts": [{"text": prompt}]}]}
            )
            res_json = ai_res.json()
            if "candidates" not in res_json:
                error_msg = res_json.get("error", {}).get("message", "AI 모델 응답 생성 실패")
                raise HTTPException(status_code=500, detail=f"AI 분석 실패: {error_msg}")
            ai_raw = res_json["candidates"][0]["content"]["parts"][0]["text"]
            if "```" in ai_raw:
                ai_raw = ai_raw.split("```")[1].replace("json", "").strip().split("```")[0].strip()
            ai_data = json.loads(ai_raw)

        # 3) 마스킹 PDF 생성/업로드 (LLM 추가 호출 없음)
        masked_bytes = _build_masked_pdf(file_bytes, ai_data)
        supabase.storage.from_(MASKED_BUCKET).upload(
            path=masked_path,
            file=masked_bytes,
            file_options={"content-type": "application/pdf"},
        )

        # 4) DB 저장
        insert_data = {
            "status": "draft",
            "region_summary": _normalize_region_summary(ai_data.get("region_summary", "위치 미확인")),
            "address_detail": ai_data.get("address_detail", ""),
            "building_name": ai_data.get("building_name", "건물명 미확인"),
            "parking_type": ai_data.get("parking_type", "기종 확인 불가"),
            "original_pdf_path": original_path,
            "masked_pdf_path": masked_path,
            "parsed_data": {
                "mandatory": _safe_list(ai_data.get("mandatory_repairs", [])),
                "optional": _safe_list(ai_data.get("optional_repairs", [])),
            },
            "selected_items": _safe_list(ai_data.get("mandatory_repairs", [])),
        }
        # 게스트 업로드 허용: 로그인 사용자인 경우에만 requester_id 저장
        if requester_id:
            insert_data["requester_id"] = requester_id
        db_res = supabase.table("repair_requests").insert(insert_data).execute()
        return {"status": "success", "data": db_res.data[0]}
    except Exception as e:
        if "row-level security policy" in str(e):
            key_hint = _key_kind(SUPABASE_SERVER_KEY)
            raise HTTPException(
                status_code=500,
                detail=(
                    "Supabase RLS 차단: 서버에서 storage/db 쓰기 권한이 부족합니다. "
                    f"현재 서버키 유형={key_hint}. 서버 환경변수에 SUPABASE_SERVICE_ROLE_KEY(또는 SUPABASE_SECRET_KEY) 설정이 필요합니다. "
                    f"원본오류: {str(e)}"
                ),
            )
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/update-request")
async def update_request(req: UpdateRequest):
    try:
        _rate_limit("update_request", req.requester_id)
        _require_active_role(req.requester_id, ["requester"], "requester")
        existing = (
            supabase.table("repair_requests")
            .select("repair_request_id, requester_id, status, quote_deadline_at")
            .eq("repair_request_id", req.repair_request_id)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="요청 건을 찾을 수 없습니다.")
        row0 = existing.data[0]
        current_requester = row0.get("requester_id")
        if current_requester and current_requester != req.requester_id:
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        update_payload = {
            "requester_id": req.requester_id,
            "selected_items": req.selected_items,
            "status": req.status,
        }
        if req.status == "requested" and not row0.get("quote_deadline_at"):
            update_payload["quote_deadline_at"] = (datetime.utcnow() + timedelta(days=14)).isoformat() + "Z"
        supabase.table("repair_requests").update(update_payload).eq(
            "repair_request_id", req.repair_request_id
        ).execute()
        # 요청 등록 시: 관심 지역 업체들에게 알림 큐 + 즉시 메일 시도
        if req.status == "requested":
            req_row = (
                supabase.table("repair_requests")
                .select("repair_request_id, region_summary")
                .eq("repair_request_id", req.repair_request_id)
                .limit(1)
                .execute()
            )
            if req_row.data:
                row = req_row.data[0]
                region = row.get("region_summary", "")
                region_norm = _normalize_region_summary(region)
                try:
                    partners = (
                        supabase.table("partner_profiles")
                        .select("partner_id, service_regions")
                        .contains("service_regions", [region_norm])
                        .execute()
                    )
                    for p in partners.data or []:
                        profile = _get_profile(p["partner_id"])
                        if not profile or profile.get("is_active") is False:
                            continue
                        _enqueue_and_maybe_send(
                            "new_request_in_interest_region",
                            p["partner_id"],
                            {
                                "repair_request_id": req.repair_request_id,
                                "region_summary": region_norm,
                                "site_alias": _site_alias(req.repair_request_id),
                            },
                        )
                except Exception:
                    pass
        return {"status": "success"}
    except HTTPException as e:
        raise e
    except Exception as e:
        if "row-level security policy" in str(e):
            key_hint = _key_kind(SUPABASE_SERVER_KEY)
            raise HTTPException(
                status_code=500,
                detail=(
                    "Supabase RLS 차단: update-request 쓰기 권한이 부족합니다. "
                    f"현재 서버키 유형={key_hint}. 서버 환경변수에 SUPABASE_SERVICE_ROLE_KEY(또는 SUPABASE_SECRET_KEY) 설정이 필요합니다. "
                    f"원본오류: {str(e)}"
                ),
            )
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/partner/{partner_id}")
async def get_partner_profile(partner_id: str):
    try:
        profile_res = (
            supabase.table("profiles")
            .select("id, role, name, phone_number, office_phone_number, company_name")
            .eq("id", partner_id)
            .limit(1)
            .execute()
        )
        if not profile_res.data:
            raise HTTPException(status_code=404, detail="업체 정보를 찾을 수 없습니다.")
        profile = profile_res.data[0]
        if profile.get("role") != "contractor":
            raise HTTPException(status_code=404, detail="업체 정보를 찾을 수 없습니다.")

        rating_res = (
            supabase.table("partner_ratings")
            .select("avg_rating, review_count")
            .eq("partner_id", partner_id)
            .limit(1)
            .execute()
        )
        rating = rating_res.data[0] if rating_res.data else {"avg_rating": 0, "review_count": 0}

        extra = {
            "business_location": None,
            "service_regions": [],
            "years_experience": None,
            "employee_count": None,
        }
        try:
            extra_res = (
                supabase.table("partner_profiles")
                .select("business_location, service_regions, years_experience, employee_count")
                .eq("partner_id", partner_id)
                .limit(1)
                .execute()
            )
            if extra_res.data:
                extra = extra_res.data[0]
        except Exception:
            pass

        return {
            "status": "success",
            "data": {
                "partner_id": partner_id,
                "name": profile.get("name"),
                "company_name": profile.get("company_name"),
                "office_phone_number": profile.get("office_phone_number"),
                "avg_rating": float(rating.get("avg_rating", 0)),
                "review_count": int(rating.get("review_count", 0)),
                **extra,
            },
        }
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/me/profile")
async def get_my_profile(user_id: str):
    try:
        profile = _get_profile(user_id)
        if not profile:
            raise HTTPException(status_code=404, detail="프로필 정보를 찾을 수 없습니다.")
        response = {"profile": profile, "partner_profile": None}
        if profile.get("role") == "contractor":
            try:
                p = (
                    supabase.table("partner_profiles")
                    .select("business_location, service_regions, years_experience, employee_count")
                    .eq("partner_id", user_id)
                    .limit(1)
                    .execute()
                )
                if p.data:
                    response["partner_profile"] = p.data[0]
            except Exception:
                pass
        return {"status": "success", "data": response}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/regions/recommend")
async def recommend_regions(base_region: str):
    try:
        base = (base_region or "").strip()
        if not base:
            return {"status": "success", "data": []}
        base_norm = _normalize_region_summary(base)
        parts = base_norm.split()
        prefix = parts[0] if parts else base_norm
        reqs = (
            supabase.table("repair_requests")
            .select("region_summary")
            .ilike("region_summary", f"{prefix}%")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        unique_regions: List[str] = []
        for r in reqs.data or []:
            v = str(r.get("region_summary", "")).strip()
            if v and v not in unique_regions:
                unique_regions.append(v)
        # cross-sido 인접 추천(수도권 우선)
        adjacent_sido_map = {
            "서울특별시": ["경기도", "인천광역시"],
            "경기도": ["서울특별시", "인천광역시", "강원특별자치도", "충청북도", "충청남도"],
            "인천광역시": ["서울특별시", "경기도"],
        }
        extra = []
        for adj in adjacent_sido_map.get(prefix, []):
            adj_rows = (
                supabase.table("repair_requests")
                .select("region_summary")
                .ilike("region_summary", f"{adj}%")
                .order("created_at", desc=True)
                .limit(80)
                .execute()
            )
            for r in adj_rows.data or []:
                v = _normalize_region_summary(str(r.get("region_summary", "")).strip())
                if v and v not in extra:
                    extra.append(v)
        result = [base_norm] + [r for r in unique_regions if r != base_norm] + extra
        return {"status": "success", "data": result[:8]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/signup-config")
async def get_signup_config():
    return {
        "status": "success",
        "data": {
            "require_contractor_approval": _is_contractor_approval_required(),
        },
    }


@app.post("/api/me/profile")
async def update_my_profile(body: MyProfileUpdate):
    try:
        if body.name is not None and body.name.strip():
            if not re.fullmatch(r"[가-힣\s]+", body.name.strip()):
                raise HTTPException(status_code=400, detail="이름은 한글만 입력 가능합니다.")
        if body.company_name is not None and body.company_name.strip():
            if not re.fullmatch(r"[가-힣A-Za-z0-9\s().,&\-]+", body.company_name.strip()):
                raise HTTPException(status_code=400, detail="상호 형식이 올바르지 않습니다.")
        before = _get_profile(body.user_id) or {}
        contractor_signup_transition = before.get("role") != "contractor" and body.role == "contractor"
        require_approval = _is_contractor_approval_required()
        base_update = {}
        if body.role in ["requester", "contractor"]:
            base_update["role"] = body.role
        if body.name is not None:
            base_update["name"] = body.name
        if body.phone_number is not None:
            base_update["phone_number"] = _normalize_phone(body.phone_number)
        if body.office_phone_number is not None:
            base_update["office_phone_number"] = _normalize_phone(body.office_phone_number)
        if body.company_name is not None:
            base_update["company_name"] = body.company_name
        if contractor_signup_transition and require_approval:
            base_update["is_active"] = False
        if base_update:
            supabase.table("profiles").update(base_update).eq("id", body.user_id).execute()

        effective_role = body.role
        if not effective_role:
            profile = _get_profile(body.user_id)
            effective_role = profile.get("role") if profile else None

        if effective_role == "contractor":
            normalized_regions = [_normalize_region_summary(r) for r in (body.service_regions or []) if str(r).strip()]
            normalized_regions = list(dict.fromkeys([r for r in normalized_regions if r]))
            upsert_payload = {
                "partner_id": body.user_id,
                "business_location": body.business_location or "",
                "service_regions": normalized_regions,
                "years_experience": body.years_experience,
                "employee_count": body.employee_count,
            }
            try:
                supabase.table("partner_profiles").upsert(upsert_payload).execute()
            except Exception as e:
                if "relation" in str(e) and "partner_profiles" in str(e):
                    raise HTTPException(
                        status_code=500,
                        detail="partner_profiles 테이블이 없습니다. 마이그레이션 SQL을 먼저 적용해주세요.",
                    )
                raise e
        if (
            effective_role == "contractor"
            and body.trigger_signup_notice
            and ADMIN_EMAIL
            and MAIL_SMTP_HOST
            and MAIL_SMTP_USER
            and MAIL_SMTP_PASS
        ):
            profile_after = _get_profile(body.user_id) or {}
            subject = "[Fix&Pass] 신규 수리업체 가입 신청"
            body_text = (
                "새 수리업체 가입 신청이 접수되었습니다.\n\n"
                f"- 이름: {profile_after.get('name') or '-'}\n"
                f"- 상호: {profile_after.get('company_name') or '-'}\n"
                f"- 소재지: {body.business_location or '-'}\n"
                f"- 전화번호: {profile_after.get('phone_number') or '-'}\n"
                f"- 사용자 ID: {body.user_id}\n"
                f"- 승인 필요 설정: {'ON' if require_approval else 'OFF'}\n"
            )
            try:
                _send_mail(ADMIN_EMAIL, subject, body_text)
            except Exception as e:
                logging.warning("contractor signup notify failed: %s", str(e))
        return {
            "status": "success",
            "data": {
                "approval_required": (effective_role == "contractor" and require_approval),
            },
        }
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _has_active_duplicate_company(company_name: str, exclude_user_id: Optional[str] = None) -> bool:
    nm = (company_name or "").strip()
    if not nm:
        return False
    q = (
        supabase.table("profiles")
        .select("id")
        .eq("role", "contractor")
        .eq("is_active", True)
        .eq("company_name", nm)
        .limit(3)
    )
    if exclude_user_id:
        q = q.neq("id", exclude_user_id)
    res = q.execute()
    return bool(res.data)


@app.get("/api/my-requests")
async def get_my_requests(requester_id: str):
    try:
        _require_active_role(requester_id, ["requester"], "requester")
        res = (
            supabase.table("repair_requests")
            .select("*")
            .eq("requester_id", requester_id)
            .order("created_at", desc=True)
            .execute()
        )
        return {"status": "success", "data": res.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests/{request_id}")
async def get_request_detail(request_id: int, requester_id: str):
    try:
        _require_active_role(requester_id, ["requester"], "requester")
        res = (
            supabase.table("repair_requests")
            .select("*")
            .eq("repair_request_id", request_id)
            .eq("requester_id", requester_id)
            .execute()
        )
        if not res.data:
            raise HTTPException(status_code=404, detail="Not found")
        return {"status": "success", "data": res.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests/{request_id}/bids")
async def get_bids_for_request(request_id: int, requester_id: str):
    """의뢰인용 견적 조회 (업체 선택 전 연락처 마스킹)."""
    try:
        _require_active_role(requester_id, ["requester"], "requester")
        req_res = (
            supabase.table("repair_requests")
            .select("selected_bid_ids, requester_id")
            .eq("repair_request_id", request_id)
            .execute()
        )
        if not req_res.data or req_res.data[0]["requester_id"] != requester_id:
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        bids_res = (
            supabase.table("bids")
            .select("*, profiles(name, phone_number)")
            .eq("repair_request_id", request_id)
            .execute()
        )
        ratings_res = supabase.table("partner_ratings").select("*").execute()
        ratings_dict = {r["partner_id"]: r for r in ratings_res.data}
        selected_ids = req_res.data[0].get("selected_bid_ids", []) or []

        processed_bids = []
        for b in bids_res.data:
            p_id = b["partner_id"]
            profile = b.get("profiles") or {}
            rating_info = ratings_dict.get(p_id, {"avg_rating": 0, "review_count": 0})
            is_selected = b["bid_id"] in selected_ids
            processed_bids.append(
                {
                    "bid_id": b["bid_id"],
                    "partner_id": p_id,
                    "partner_name": profile.get("name", "업체명 미확인"),
                    "partner_phone": profile.get("phone_number") if is_selected else "010-****-****",
                    "bid_amount": b["bid_amount"],
                    "avg_rating": float(rating_info["avg_rating"]),
                    "review_count": int(rating_info["review_count"]),
                    "is_selected": is_selected,
                }
            )
        return {"status": "success", "data": processed_bids}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/my-requests/{request_id}/cancel")
async def cancel_request(request_id: int, requester_id: str):
    try:
        _require_active_role(requester_id, ["requester"], "requester")
        req_res = (
            supabase.table("repair_requests")
            .select("repair_request_id, requester_id, status")
            .eq("repair_request_id", request_id)
            .eq("requester_id", requester_id)
            .limit(1)
            .execute()
        )
        if not req_res.data:
            raise HTTPException(status_code=404, detail="요청 건을 찾을 수 없습니다.")
        status = req_res.data[0].get("status")
        if status not in ["requested", "bidding"]:
            raise HTTPException(status_code=400, detail="현재 상태에서는 취소할 수 없습니다.")
        supabase.table("repair_requests").update({"status": "cancelled"}).eq("repair_request_id", request_id).execute()
        return {"status": "success"}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/requests/{request_id}/pdf")
async def get_request_pdf_url(request_id: int, viewer: str, user_id: str):
    """
    viewer=requester -> 원본 PDF signed URL
    viewer=contractor -> 마스킹 PDF signed URL
    """
    try:
        req_res = (
            supabase.table("repair_requests")
            .select("requester_id, selected_bid_ids, masked_pdf_path, original_pdf_path")
            .eq("repair_request_id", request_id)
            .execute()
        )
        if not req_res.data:
            raise HTTPException(status_code=404, detail="Not found")

        req = req_res.data[0]
        if viewer == "requester":
            if req["requester_id"] != user_id:
                raise HTTPException(status_code=403, detail="권한이 없습니다.")
            signed = supabase.storage.from_(ORIGINAL_BUCKET).create_signed_url(
                req["original_pdf_path"], 300
            )
            return {"status": "success", "url": signed.get("signedURL")}

        if viewer == "contractor":
            _require_active_role(user_id, ["contractor"], "contractor")

            signed = supabase.storage.from_(MASKED_BUCKET).create_signed_url(
                req["masked_pdf_path"], 300
            )
            return {"status": "success", "url": signed.get("signedURL")}

        raise HTTPException(status_code=400, detail="viewer 값이 잘못되었습니다.")
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contractor/market")
async def get_market_list(partner_id: str, request_status: Optional[str] = None, my_status_filter: Optional[str] = None):
    """수리업체용: 지역(시/군/구)+수리항목 중심 마켓 목록(상세주소 비노출)."""
    try:
        _require_active_role(partner_id, ["contractor"], "contractor")
        req_res = (
            supabase.table("repair_requests")
            .select(
                "repair_request_id, status, region_summary, building_name, parking_type, "
                "selected_items, selected_bid_ids, created_at, quote_deadline_at"
            )
            .in_("status", ["requested", "bidding", "matched", "repairing", "completed"])
            .order("created_at", desc=True)
            .execute()
        )
        bid_res = (
            supabase.table("bids")
            .select("repair_request_id, bid_id, created_at")
            .eq("partner_id", partner_id)
            .execute()
        )
        my_bids_by_request = {}
        for b in bid_res.data or []:
            rid = b["repair_request_id"]
            my_bids_by_request[rid] = {
                "bid_id": b["bid_id"],
                "created_at": b.get("created_at"),
            }
        market_data = []
        for r in req_res.data or []:
            request_id = r["repair_request_id"]
            my_bid_info = my_bids_by_request.get(request_id)
            my_bid_id = my_bid_info["bid_id"] if my_bid_info else None
            r["my_bid_submitted_at"] = (my_bid_info or {}).get("created_at")
            selected_ids = r.get("selected_bid_ids", []) or []
            stage_kr = _request_stage_kr(r.get("status", ""))
            if not my_bid_id:
                my_bid_status = "미제출"
            elif my_bid_id in selected_ids:
                my_bid_status = "내 견적 선택됨"
            else:
                my_bid_status = "견적 제출완료"
            if selected_ids and (not my_bid_id or my_bid_id not in selected_ids):
                my_bid_status = "타업체 선정됨"
            r["site_alias"] = _site_alias(request_id)
            r["building_name"] = None
            r["already_bid"] = bool(my_bid_id)
            r["my_bid_status"] = my_bid_status
            r["request_stage_kr"] = stage_kr
            if request_status and request_status != "ALL" and r.get("status") != request_status:
                continue
            if my_status_filter and my_status_filter != "ALL" and r.get("my_bid_status") != my_status_filter:
                continue
            market_data.append(r)
        return {"status": "success", "data": market_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contractor/market/{request_id}")
async def get_market_detail(request_id: int, partner_id: str):
    """수리업체용 상세: 상세주소/원본PDF 비공개."""
    try:
        _require_active_role(partner_id, ["contractor"], "contractor")
        req_res = (
            supabase.table("repair_requests")
            .select(
                "repair_request_id, status, region_summary, building_name, parking_type, "
                "selected_items, selected_bid_ids, parsed_data, created_at, quote_deadline_at"
            )
            .eq("repair_request_id", request_id)
            .execute()
        )
        if not req_res.data:
            raise HTTPException(status_code=404, detail="Not found")

        my_bid = (
            supabase.table("bids")
            .select("*")
            .eq("repair_request_id", request_id)
            .eq("partner_id", partner_id)
            .execute()
        )
        data = req_res.data[0]
        data["my_bid"] = my_bid.data[0] if my_bid.data else None
        data["site_alias"] = _site_alias(request_id)
        data["building_name"] = None
        selected_ids = data.get("selected_bid_ids", []) or []
        my_bid_id = data["my_bid"]["bid_id"] if data.get("my_bid") else None
        if not my_bid_id:
            data["my_bid_status"] = "미제출"
        elif my_bid_id in selected_ids:
            data["my_bid_status"] = "내 견적 선택됨"
        else:
            data["my_bid_status"] = "견적 제출완료"
        if selected_ids and (not my_bid_id or my_bid_id not in selected_ids):
            data["my_bid_status"] = "타업체 선정됨"
        data["request_stage_kr"] = _request_stage_kr(data.get("status", ""))
        return {"status": "success", "data": data}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/contractor/bid")
async def submit_bid(bid: BidSubmission):
    try:
        _rate_limit("submit_bid", bid.partner_id)
        _require_active_role(bid.partner_id, ["contractor"], "contractor")
        req_res = (
            supabase.table("repair_requests")
            .select("status")
            .eq("repair_request_id", bid.repair_request_id)
            .execute()
        )
        if not req_res.data:
            raise HTTPException(status_code=404, detail="Not found")

        current_status = req_res.data[0]["status"]
        if current_status in ["matched", "repairing", "completed"]:
            raise HTTPException(status_code=400, detail="이미 매칭된 건은 수정 불가")

        existing_bid = (
            supabase.table("bids")
            .select("*")
            .eq("repair_request_id", bid.repair_request_id)
            .eq("partner_id", bid.partner_id)
            .execute()
        )
        is_first_bid = not bool(existing_bid.data)
        if existing_bid.data:
            current_bid = existing_bid.data[0]
            if current_bid.get("edit_count", 0) >= 1:
                raise HTTPException(status_code=400, detail="견적 수정은 1회만 가능")

            res = (
                supabase.table("bids")
                .update(
                    {
                        "original_bid_amount": current_bid["bid_amount"],
                        "bid_amount": bid.bid_amount,
                        "edit_count": current_bid.get("edit_count", 0) + 1,
                        "updated_at": datetime.utcnow().isoformat(),
                    }
                )
                .eq("bid_id", current_bid["bid_id"])
                .execute()
            )
            bid_action = "updated"
        else:
            res = (
                supabase.table("bids")
                .insert(
                    {
                        "repair_request_id": bid.repair_request_id,
                        "partner_id": bid.partner_id,
                        "bid_amount": bid.bid_amount,
                        "edit_count": 0,
                    }
                )
                .execute()
            )
            bid_action = "created"

        if current_status == "requested":
            (
                supabase.table("repair_requests")
                .update({"status": "bidding"})
                .eq("repair_request_id", bid.repair_request_id)
                .execute()
            )
        if is_first_bid:
            _enqueue_and_maybe_send(
                "first_bid_submitted",
                bid.partner_id,
                {
                    "repair_request_id": bid.repair_request_id,
                    "bid_id": res.data[0].get("bid_id"),
                },
            )
        # 의뢰인에게 신규 견적 등록 알림
        req_owner = (
            supabase.table("repair_requests")
            .select("requester_id")
            .eq("repair_request_id", bid.repair_request_id)
            .limit(1)
            .execute()
        )
        if req_owner.data and req_owner.data[0].get("requester_id"):
            _enqueue_and_maybe_send(
                "new_bid_for_requester",
                req_owner.data[0]["requester_id"],
                {
                    "repair_request_id": bid.repair_request_id,
                    "bid_id": res.data[0].get("bid_id"),
                    "bid_amount": f"{int(bid.bid_amount):,}원",
                    "action": bid_action,
                },
            )
        return {"status": "success", "data": res.data[0]}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/match-partners")
async def match_partners(data: MatchPartners):
    try:
        _rate_limit("match_partners", data.requester_id)
        _require_active_role(data.requester_id, ["requester"], "requester")
        if len(data.selected_bid_ids) > 2:
            raise HTTPException(status_code=400, detail="최대 2개 업체만 가능")
        (
            supabase.table("repair_requests")
            .update(
                {
                    "selected_bid_ids": data.selected_bid_ids,
                    "status": "matched" if data.selected_bid_ids else "bidding",
                    "contact_unlocked_at": datetime.utcnow().isoformat()
                    if data.selected_bid_ids
                    else None,
                }
            )
            .eq("repair_request_id", data.repair_request_id)
            .eq("requester_id", data.requester_id)
            .execute()
        )
        if data.selected_bid_ids:
            selected_bids = (
                supabase.table("bids")
                .select("bid_id, partner_id")
                .in_("bid_id", data.selected_bid_ids)
                .execute()
            )
            for b in selected_bids.data or []:
                _enqueue_and_maybe_send(
                    "requester_selected_partner",
                    b.get("partner_id"),
                    {
                        "repair_request_id": data.repair_request_id,
                        "selected_bid_id": b.get("bid_id"),
                    },
                )
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _user_email_for_id(user_id: str) -> Optional[str]:
    try:
        r = supabase.auth.admin.get_user_by_id(user_id)
        return getattr(getattr(r, "user", None), "email", None)
    except Exception:
        return None


@functools.lru_cache(maxsize=512)
def _cached_auth_email_lower(user_id: str) -> str:
    return (_user_email_for_id(user_id) or "").lower()


def _reply_row_is_admin_reply(row: dict) -> bool:
    if row.get("is_staff"):
        return True
    if not ADMIN_EMAIL:
        return False
    return _cached_auth_email_lower(str(row.get("author_id") or "")) == ADMIN_EMAIL


def _admin_reply_counts_by_inquiry(inquiry_ids: List[int]) -> dict[int, int]:
    if not inquiry_ids:
        return {}
    try:
        reps = (
            supabase.table("inquiry_replies")
            .select("inquiry_id, author_id, is_staff")
            .in_("inquiry_id", inquiry_ids)
            .execute()
        )
    except Exception:
        reps = (
            supabase.table("inquiry_replies")
            .select("inquiry_id, author_id")
            .in_("inquiry_id", inquiry_ids)
            .execute()
        )
    counts: defaultdict[int, int] = defaultdict(int)
    for row in reps.data or []:
        if _reply_row_is_admin_reply(row):
            counts[int(row["inquiry_id"])] += 1
    return dict(counts)


@app.get("/api/site-announcement")
async def public_site_announcement():
    """첫 화면용: 배포 중인 단일 팝업 문구."""
    try:
        res = (
            supabase.table("site_announcements")
            .select("id, title, message, updated_at")
            .eq("is_active", True)
            .order("updated_at", desc=True)
            .limit(1)
            .execute()
        )
    except Exception:
        return {"status": "success", "data": None}
    rows = res.data or []
    return {"status": "success", "data": rows[0] if rows else None}


@app.get("/api/inquiries")
async def list_inquiries(authorization: Optional[str] = Header(default=None)):
    res = (
        supabase.table("inquiries")
        .select("id, title, created_at, author_id")
        .order("created_at", desc=True)
        .limit(100)
        .execute()
    )
    mine: Optional[str] = None
    if authorization:
        try:
            mine = _require_authenticated_user(authorization)["id"]
        except HTTPException:
            mine = None
    rows = res.data or []
    iids = [int(r["id"]) for r in rows]
    counts = _admin_reply_counts_by_inquiry(iids)
    out = []
    for r in rows:
        iid = int(r["id"])
        n_admin = counts.get(iid, 0)
        status_kr = "답변완료" if n_admin > 0 else "답변전"
        out.append(
            {
                "id": iid,
                "title": r["title"],
                "created_at": r["created_at"],
                "is_mine": bool(mine and r.get("author_id") == mine),
                "reply_status": "answered" if n_admin > 0 else "pending",
                "reply_status_kr": status_kr,
            }
        )
    return {"status": "success", "data": out}


@app.get("/api/inquiries/{inquiry_id}")
async def get_inquiry_detail(inquiry_id: int, authorization: Optional[str] = Header(default=None)):
    res = supabase.table("inquiries").select("*").eq("id", inquiry_id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="문의를 찾을 수 없습니다.")
    row = res.data[0]
    mine: Optional[str] = None
    is_admin_session = False
    if authorization:
        try:
            u = _require_authenticated_user(authorization)
            mine = u["id"]
        except HTTPException:
            mine = None
        try:
            tok = _extract_bearer(authorization)
            ur = supabase.auth.get_user(tok)
            uu = getattr(ur, "user", None)
            if uu and uu.email and ADMIN_EMAIL and str(uu.email).lower() == ADMIN_EMAIL:
                is_admin_session = True
        except Exception:
            is_admin_session = False
    is_mine = bool(mine and row.get("author_id") == mine)
    try:
        rep = (
            supabase.table("inquiry_replies")
            .select("id, body, created_at, author_id, is_staff, updated_at")
            .eq("inquiry_id", inquiry_id)
            .order("created_at", desc=False)
            .execute()
        )
    except Exception:
        rep = (
            supabase.table("inquiry_replies")
            .select("id, body, created_at, author_id")
            .eq("inquiry_id", inquiry_id)
            .order("created_at", desc=False)
            .execute()
        )
    replies_out = []
    for r in rep.data or []:
        replies_out.append(
            {
                "id": r["id"],
                "body": r["body"],
                "created_at": r["created_at"],
                "updated_at": r.get("updated_at"),
                "is_admin": _reply_row_is_admin_reply(r),
            }
        )
    followups_out: List[dict] = []
    try:
        fup = (
            supabase.table("inquiry_followups")
            .select("id, body, created_at, author_id")
            .eq("inquiry_id", inquiry_id)
            .order("created_at", desc=False)
            .execute()
        )
        for f in fup.data or []:
            followups_out.append(
                {
                    "id": f["id"],
                    "body": f["body"],
                    "created_at": f["created_at"],
                    "author_id": f.get("author_id"),
                }
            )
    except Exception:
        followups_out = []

    timeline: List[dict] = []
    for r in replies_out:
        timeline.append(
            {
                "kind": "admin_reply",
                "id": r["id"],
                "body": r["body"],
                "created_at": r["created_at"],
                "updated_at": r.get("updated_at"),
                "is_admin": r["is_admin"],
            }
        )
    for f in followups_out:
        timeline.append(
            {
                "kind": "user_followup",
                "id": f["id"],
                "body": f["body"],
                "created_at": f["created_at"],
                "is_admin": False,
            }
        )
    timeline.sort(key=lambda x: str(x.get("created_at") or ""))

    n_admin = sum(1 for r in replies_out if r["is_admin"])
    reply_status = "answered" if n_admin > 0 else "pending"
    can_followup = bool(is_mine and reply_status == "answered")

    return {
        "status": "success",
        "data": {
            "id": row["id"],
            "title": row["title"],
            "body": row["body"],
            "created_at": row["created_at"],
            "author_id": row.get("author_id"),
            "is_mine": is_mine,
            "is_admin_session": is_admin_session,
            "replies": replies_out,
            "followups": followups_out,
            "timeline": timeline,
            "reply_status": reply_status,
            "reply_status_kr": "답변완료" if reply_status == "answered" else "답변전",
            "can_followup": can_followup,
        },
    }


@app.post("/api/inquiries")
async def create_inquiry(
    body: InquiryCreate,
    authorization: Optional[str] = Header(default=None),
):
    user = _require_authenticated_user(authorization)
    _rate_limit("inquiry_create", user["id"])
    if not body.title.strip() or not body.body.strip():
        raise HTTPException(status_code=400, detail="제목과 내용을 입력해주세요.")
    ins = (
        supabase.table("inquiries")
        .insert(
            {
                "author_id": user["id"],
                "title": body.title.strip(),
                "body": body.body.strip(),
            }
        )
        .execute()
    )
    new_id = ins.data[0]["id"] if ins.data else None
    if ADMIN_EMAIL and MAIL_SMTP_HOST and MAIL_SMTP_USER and MAIL_SMTP_PASS:
        try:
            subj = "[Fix&Pass] 신규 고객 문의가 등록되었습니다"
            mail_body = (
                "안녕하세요. Fix&Pass 관리자 알림입니다.\n\n"
                "새 고객 문의가 등록되었습니다.\n"
                f"- 문의 ID: {new_id}\n"
                f"- 작성자: {user['email'] or '-'}\n"
                f"- 제목: {body.title.strip()}\n"
                f"- 등록 시각: {datetime.utcnow().isoformat()}Z\n\n"
                f"관리자 페이지에서 확인: /inquiry/{new_id}"
            )
            _send_mail(ADMIN_EMAIL, subj, mail_body)
        except Exception as e:
            logging.warning("new inquiry admin mail failed: %s", str(e))
    return {"status": "success", "data": {"id": new_id}}


@app.post("/api/inquiries/{inquiry_id}/reply")
async def create_inquiry_reply(
    inquiry_id: int,
    body: InquiryReplyCreate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="답변 내용을 입력해주세요.")
    chk = supabase.table("inquiries").select("id").eq("id", inquiry_id).limit(1).execute()
    if not chk.data:
        raise HTTPException(status_code=404, detail="문의를 찾을 수 없습니다.")
    row = {
        "inquiry_id": inquiry_id,
        "author_id": admin["id"],
        "body": body.body.strip(),
        "is_staff": True,
    }
    try:
        supabase.table("inquiry_replies").insert(row).execute()
    except Exception:
        row.pop("is_staff", None)
        supabase.table("inquiry_replies").insert(row).execute()
    _cached_auth_email_lower.cache_clear()
    _log_admin_action("inquiry_reply", admin["email"], {"inquiry_id": inquiry_id})
    return {"status": "success"}


@app.patch("/api/admin/inquiry-replies/{reply_id}")
async def admin_patch_inquiry_reply(
    reply_id: int,
    body: InquiryReplyPatch,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="답변 내용을 입력해주세요.")
    rep = supabase.table("inquiry_replies").select("*").eq("id", reply_id).limit(1).execute()
    if not rep.data:
        raise HTTPException(status_code=404, detail="답변을 찾을 수 없습니다.")
    row = rep.data[0]
    if not _reply_row_is_admin_reply(row):
        raise HTTPException(status_code=403, detail="관리자 답변만 수정할 수 있습니다.")
    now_iso = datetime.utcnow().isoformat() + "Z"
    try:
        supabase.table("inquiry_replies").update(
            {"body": body.body.strip(), "updated_at": now_iso}
        ).eq("id", reply_id).execute()
    except Exception:
        supabase.table("inquiry_replies").update({"body": body.body.strip()}).eq("id", reply_id).execute()
    _cached_auth_email_lower.cache_clear()
    _log_admin_action("inquiry_reply_edit", admin["email"], {"reply_id": reply_id})
    return {"status": "success"}


@app.post("/api/inquiries/{inquiry_id}/followup")
async def create_inquiry_followup(
    inquiry_id: int,
    body: InquiryFollowupCreate,
    authorization: Optional[str] = Header(default=None),
):
    user = _require_authenticated_user(authorization)
    _rate_limit("inquiry_followup", user["id"])
    if not body.body.strip():
        raise HTTPException(status_code=400, detail="내용을 입력해주세요.")
    inv = supabase.table("inquiries").select("id, author_id").eq("id", inquiry_id).limit(1).execute()
    if not inv.data:
        raise HTTPException(status_code=404, detail="문의를 찾을 수 없습니다.")
    if str(inv.data[0].get("author_id")) != str(user["id"]):
        raise HTTPException(status_code=403, detail="본인 문의에만 추가 문의를 남길 수 있습니다.")
    counts = _admin_reply_counts_by_inquiry([inquiry_id])
    if counts.get(inquiry_id, 0) < 1:
        raise HTTPException(status_code=400, detail="관리자 답변(답변 완료) 이후에만 추가 문의를 작성할 수 있습니다.")
    try:
        supabase.table("inquiry_followups").insert(
            {
                "inquiry_id": inquiry_id,
                "author_id": user["id"],
                "body": body.body.strip(),
            }
        ).execute()
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"추가 문의 저장 실패: {str(e)}. DB에 inquiry_followups 테이블이 있는지 확인해주세요.",
        )
    return {"status": "success"}


@app.get("/api/admin/inquiries")
async def admin_list_inquiries(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    res = (
        supabase.table("inquiries")
        .select("id, title, created_at, author_id")
        .order("created_at", desc=True)
        .limit(150)
        .execute()
    )
    rows = res.data or []
    iids = [int(r["id"]) for r in rows]
    counts = _admin_reply_counts_by_inquiry(iids)
    out = []
    for r in rows:
        iid = int(r["id"])
        n = counts.get(iid, 0)
        em = _cached_auth_email_lower(str(r.get("author_id") or "")) or None
        out.append(
            {
                "id": iid,
                "title": r["title"],
                "created_at": r["created_at"],
                "author_id": r.get("author_id"),
                "author_email": em if em else None,
                "reply_status_kr": "답변완료" if n > 0 else "답변전",
            }
        )
    return {"status": "success", "data": out}


def _unwrap_auth_user_list(resp) -> list:
    if resp is None:
        return []
    if isinstance(resp, list):
        return resp
    u = getattr(resp, "users", None)
    if u is not None:
        return list(u)
    if isinstance(resp, dict) and "users" in resp:
        return list(resp["users"])
    return []


@app.get("/api/admin/auth-users")
async def admin_list_auth_users(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    all_users: list = []
    page = 1
    for _ in range(20):
        try:
            chunk = supabase.auth.admin.list_users(page=page, per_page=200)
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Auth 사용자 목록 조회 실패: {str(e)}")
        users = chunk if isinstance(chunk, list) else _unwrap_auth_user_list(chunk)
        if not users:
            break
        all_users.extend(users)
        if len(users) < 200:
            break
        page += 1

    ids = []
    for u in all_users:
        if isinstance(u, dict):
            uid = u.get("id")
        elif hasattr(u, "model_dump"):
            uid = u.model_dump().get("id")
        else:
            uid = getattr(u, "id", None)
        if uid:
            ids.append(str(uid))
    profiles_by_id: dict = {}
    if ids:
        pres = (
            supabase.table("profiles")
            .select("id, role, is_active, name, phone_number, office_phone_number, company_name, created_at")
            .in_("id", ids)
            .execute()
        )
        for p in pres.data or []:
            profiles_by_id[str(p["id"])] = p

    out = []
    for u in all_users:
        if isinstance(u, dict):
            uid = str(u.get("id") or "")
            email = u.get("email")
        elif hasattr(u, "model_dump"):
            ud = u.model_dump()
            uid = str(ud.get("id") or "")
            email = ud.get("email")
        else:
            uid = str(getattr(u, "id", "") or "")
            email = getattr(u, "email", None)
        prof = profiles_by_id.get(uid, {})
        if "is_active" not in prof:
            prof = {**prof, "is_active": True}
        out.append(
            {
                "id": uid,
                "email": email,
                "name": prof.get("name"),
                "phone_number": prof.get("phone_number"),
                "office_phone_number": prof.get("office_phone_number"),
                "company_name": prof.get("company_name"),
                "role": prof.get("role"),
                "is_active": prof.get("is_active", True),
                "profile_created_at": prof.get("created_at"),
            }
        )
    out.sort(key=lambda x: (x.get("email") or "").lower())
    return {"status": "success", "data": out}


@app.post("/api/admin/auth-users/{user_id}/password")
async def admin_set_user_password(
    user_id: str,
    body: AdminPasswordUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    pw = body.new_password.strip()
    if len(pw) < 6:
        raise HTTPException(status_code=400, detail="비밀번호는 6자 이상이어야 합니다.")
    try:
        supabase.auth.admin.update_user_by_id(user_id, {"password": pw})
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    _log_admin_action("admin_set_password", admin["email"], {"user_id": user_id})
    return {"status": "success"}


@app.post("/api/admin/auth-users/{user_id}/remove")
async def admin_delete_auth_user(
    user_id: str,
    body: AdminDeleteUserBody,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    try:
        ures = supabase.auth.admin.get_user_by_id(user_id)
        target = getattr(ures, "user", None)
        target_email = (getattr(target, "email", None) or "").lower()
    except Exception:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    if not target_email:
        raise HTTPException(status_code=400, detail="대상 이메일을 확인할 수 없습니다.")
    if target_email == ADMIN_EMAIL:
        raise HTTPException(status_code=400, detail="관리자 계정은 삭제할 수 없습니다.")
    if (body.confirm_email or "").strip().lower() != target_email:
        raise HTTPException(status_code=400, detail="확인용 이메일이 대상 계정과 일치하지 않습니다.")
    try:
        supabase.auth.admin.delete_user(user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    _log_admin_action("admin_delete_user", admin["email"], {"user_id": user_id, "email": target_email})
    return {"status": "success"}


@app.get("/api/admin/site-announcements")
async def admin_list_site_announcements(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    res = (
        supabase.table("site_announcements")
        .select("id, title, message, is_active, created_at, updated_at")
        .order("id", desc=True)
        .limit(40)
        .execute()
    )
    return {"status": "success", "data": res.data or []}


@app.get("/api/admin/settings/contractor-approval")
async def admin_get_contractor_approval_setting(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    return {
        "status": "success",
        "data": {"require_approval": _is_contractor_approval_required()},
    }


@app.post("/api/admin/settings/contractor-approval")
async def admin_set_contractor_approval_setting(
    body: ContractorApprovalSettingUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    _set_contractor_approval_required(body.require_approval)
    _log_admin_action(
        "contractor_approval_setting",
        admin["email"],
        {"require_approval": body.require_approval},
    )
    return {"status": "success"}


@app.post("/api/admin/site-announcements/deploy")
async def admin_deploy_site_announcement(
    body: SiteAnnouncementDeploy,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    msg = body.message.strip()
    if not msg:
        raise HTTPException(status_code=400, detail="팝업 내용을 입력해주세요.")
    active_rows = (
        supabase.table("site_announcements")
        .select("id")
        .eq("is_active", True)
        .execute()
        .data
        or []
    )
    for r in active_rows:
        supabase.table("site_announcements").update({"is_active": False}).eq("id", r["id"]).execute()
    now_iso = datetime.utcnow().isoformat() + "Z"
    ins = (
        supabase.table("site_announcements")
        .insert(
            {
                "title": (body.title or "").strip() or None,
                "message": msg,
                "is_active": True,
                "updated_at": now_iso,
            }
        )
        .execute()
    )
    _log_admin_action("site_announcement_deploy", admin["email"], {"id": ins.data[0]["id"] if ins.data else None})
    return {"status": "success", "data": ins.data[0] if ins.data else None}


@app.post("/api/admin/site-announcements/{announcement_id}/deactivate")
async def admin_deactivate_site_announcement(
    announcement_id: int,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    supabase.table("site_announcements").update({"is_active": False}).eq("id", announcement_id).execute()
    _log_admin_action("site_announcement_off", admin["email"], {"id": announcement_id})
    return {"status": "success"}


@app.get("/api/admin/overview")
async def admin_overview(authorization: Optional[str] = Header(default=None)):
    admin = _require_admin(authorization)
    req_count = supabase.table("repair_requests").select("*", count="exact").limit(1).execute().count or 0
    bid_count = supabase.table("bids").select("*", count="exact").limit(1).execute().count or 0
    profile_count = supabase.table("profiles").select("*", count="exact").limit(1).execute().count or 0
    status_rows = (
        supabase.table("repair_requests")
        .select("repair_request_id, status, created_at, building_name, region_summary, requester_id")
        .order("created_at", desc=True)
        .limit(20)
        .execute()
    )
    return {
        "status": "success",
        "data": {
            "admin_email": admin["email"],
            "counts": {
                "requests": req_count,
                "bids": bid_count,
                "profiles": profile_count,
            },
            "recent_requests": status_rows.data or [],
        },
    }


@app.get("/api/admin/users")
async def admin_users(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    try:
        users = (
            supabase.table("profiles")
            .select("id, role, is_active, name, phone_number, office_phone_number, company_name, created_at")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
    except Exception:
        users = (
            supabase.table("profiles")
            .select("id, role, name, phone_number, office_phone_number, company_name, created_at")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
        data = users.data or []
        for row in data:
            row["is_active"] = True
        return {"status": "success", "data": data}
    return {"status": "success", "data": users.data or []}


@app.post("/api/admin/users/{user_id}/role")
async def admin_update_user_role(
    user_id: str,
    body: AdminUserRoleUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if body.role not in ["requester", "contractor"]:
        raise HTTPException(status_code=400, detail="role 값이 잘못되었습니다.")
    supabase.table("profiles").update({"role": body.role}).eq("id", user_id).execute()
    _log_admin_action("update_user_role", admin["email"], {"user_id": user_id, "role": body.role})
    return {"status": "success"}


@app.post("/api/admin/users/{user_id}/active")
async def admin_update_user_active(
    user_id: str,
    body: AdminUserActiveUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if body.is_active:
        prof = (
            supabase.table("profiles")
            .select("id, role, company_name")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
        p = prof.data[0] if prof.data else None
        if p and p.get("role") == "contractor":
            nm = (p.get("company_name") or "").strip()
            if nm and _has_active_duplicate_company(nm, exclude_user_id=user_id) and not body.force_duplicate_ok:
                raise HTTPException(
                    status_code=409,
                    detail="동일 상호의 활성 업체가 이미 있습니다. 중복 확인 후 승인하세요.",
                )
    try:
        supabase.table("profiles").update({"is_active": body.is_active}).eq("id", user_id).execute()
    except Exception as e:
        if "column" in str(e) and "is_active" in str(e):
            raise HTTPException(
                status_code=500,
                detail=(
                    "profiles.is_active 컬럼이 없습니다. 아래 SQL을 실행해주세요: "
                    "alter table public.profiles add column if not exists is_active boolean not null default true;"
                ),
            )
        raise e
    _log_admin_action("update_user_active", admin["email"], {"user_id": user_id, "is_active": body.is_active})
    return {"status": "success"}


@app.post("/api/admin/auth-users/bulk-remove")
async def admin_bulk_delete_auth_users(
    body: AdminUserBulkDeleteBody,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    ids = list(dict.fromkeys([str(x).strip() for x in (body.user_ids or []) if str(x).strip()]))
    if not ids:
        raise HTTPException(status_code=400, detail="삭제할 user_ids가 비어 있습니다.")
    removed = 0
    failed = []
    profiles = supabase.table("profiles").select("id, role, company_name").in_("id", ids).execute()
    pmap = {str(p["id"]): p for p in (profiles.data or [])}
    for uid in ids:
        p = pmap.get(uid, {})
        try:
            ures = supabase.auth.admin.get_user_by_id(uid)
            target_email = getattr(getattr(ures, "user", None), "email", None)
            supabase.table("admin_user_deletion_archive").insert(
                {
                    "user_id": uid,
                    "email": target_email,
                    "role": p.get("role"),
                    "company_name": p.get("company_name"),
                    "requested_by": admin["email"],
                }
            ).execute()
            supabase.auth.admin.delete_user(uid)
            removed += 1
        except Exception as e:
            failed.append({"user_id": uid, "error": str(e)})
    _log_admin_action("admin_bulk_delete_users", admin["email"], {"requested": len(ids), "removed": removed})
    return {"status": "success", "data": {"requested": len(ids), "removed": removed, "failed": failed}}


@app.post("/api/admin/requests/bulk-status")
async def admin_bulk_update_request_status(
    body: AdminBulkRequestStatusUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    ids = list(dict.fromkeys([int(x) for x in (body.request_ids or [])]))
    if not ids:
        raise HTTPException(status_code=400, detail="변경할 request_ids가 비어 있습니다.")
    if body.status not in ["draft", "requested", "bidding", "matched", "repairing", "completed", "cancelled"]:
        raise HTTPException(status_code=400, detail="지원하지 않는 status 입니다.")
    supabase.table("repair_requests").update({"status": body.status}).in_("repair_request_id", ids).execute()
    _log_admin_action("bulk_update_request_status", admin["email"], {"count": len(ids), "status": body.status})
    return {"status": "success", "data": {"updated_count": len(ids)}}


@app.get("/api/admin/action-logs")
async def admin_action_logs(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    try:
        rows = (
            supabase.table("admin_action_logs")
            .select("id, action, admin_email, payload, created_at")
            .order("created_at", desc=True)
            .limit(300)
            .execute()
        )
        return {"status": "success", "data": rows.data or []}
    except Exception:
        return {"status": "success", "data": []}


@app.post("/api/notifications/process")
async def process_notification_queue(
    cron_secret: Optional[str] = Header(default=None, alias="cron-secret"),
    x_cron_secret: Optional[str] = Header(default=None, alias="X-Cron-Secret"),
    x_mail_cron: Optional[str] = Header(default=None, alias="X-Mail-Cron-Secret"),
    cron_secret_q: Optional[str] = Query(default=None, alias="cron_secret"),
):
    try:
        if not MAIL_CRON_SECRET:
            raise HTTPException(
                status_code=500,
                detail="MAIL_CRON_SECRET(또는 NOTIFICATION_CRON_SECRET) 환경변수가 필요합니다.",
            )
        provided = (
            (cron_secret or "").strip()
            or (x_cron_secret or "").strip()
            or (x_mail_cron or "").strip()
            or (cron_secret_q or "").strip()
        )
        if provided != MAIL_CRON_SECRET:
            raise HTTPException(
                status_code=403,
                detail=(
                    "잘못된 cron_secret 입니다. Render 등에서는 "
                    "헤더 `cron-secret`(권장) 또는 `X-Cron-Secret`, "
                    "또는 쿼리 `?cron_secret=` 값이 서버의 MAIL_CRON_SECRET과 "
                    "동일한지(공백 없이) 확인하세요."
                ),
            )
        rows = (
            supabase.table("notification_queue")
            .select("notification_id, event_type, user_id, payload, status")
            .eq("status", "pending")
            .order("created_at", desc=False)
            .limit(50)
            .execute()
        )
        processed = 0
        failed = 0
        for n in rows.data or []:
            n_id = n["notification_id"]
            try:
                profile = (
                    supabase.table("profiles")
                    .select("id, name")
                    .eq("id", n["user_id"])
                    .limit(1)
                    .execute()
                )
                if not profile.data:
                    raise RuntimeError("user profile not found")
                auth_user = supabase.auth.admin.get_user_by_id(n["user_id"])
                email = getattr(getattr(auth_user, "user", None), "email", None)
                if not email:
                    raise RuntimeError("user email not found")

                payload = n.get("payload") or {}
                if n["event_type"] == "first_bid_submitted":
                    subject = "[Fix&Pass] 최초 견적 제출이 접수되었습니다"
                    body = (
                        "최초 견적 제출이 정상 접수되었습니다.\n\n"
                        f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                        "의뢰인이 업체를 선택하면 추가 안내 메일이 발송됩니다."
                    )
                elif n["event_type"] == "requester_selected_partner":
                    subject = "[Fix&Pass] 의뢰인이 업체를 선택했습니다"
                    body = (
                        "축하합니다. 제출하신 견적이 의뢰인에게 선택되었습니다.\n\n"
                        f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                        f"- 선택된 견적 ID: {payload.get('selected_bid_id')}\n"
                        "서비스에서 상세 진행 상태를 확인해주세요."
                    )
                elif n["event_type"] == "new_request_in_interest_region":
                    subject = "[Fix&Pass] 신규 견적 요청이 등록되었습니다"
                    body = (
                        "안녕하세요. Fix&Pass 알림입니다.\n\n"
                        "관심 지역에 새로운 견적 요청이 등록되었습니다.\n"
                        f"- 현장 별칭: {payload.get('site_alias')}\n"
                        f"- 요청 ID: {payload.get('repair_request_id')}\n"
                        f"- 지역: {payload.get('region_summary')}\n"
                        "수리 마켓에서 상세 내용을 확인해 주세요."
                    )
                elif n["event_type"] == "new_bid_for_requester":
                    action = payload.get("action") or "created"
                    action_kr = "신규 등록" if action == "created" else "수정"
                    subject = f"[Fix&Pass] 요청하신 건에 견적이 {action_kr}되었습니다"
                    body = (
                        "안녕하세요. Fix&Pass 알림입니다.\n\n"
                        f"요청하신 수리 건에 견적이 {action_kr}되었습니다.\n"
                        f"- 수리요청 ID: {payload.get('repair_request_id')}\n"
                        f"- 견적 ID: {payload.get('bid_id')}\n"
                        f"- 견적 금액: {payload.get('bid_amount')}\n\n"
                        "내 요청 내역에서 상세 견적을 확인해 주세요."
                    )
                else:
                    subject = "[Fix&Pass] 알림"
                    body = f"새 알림이 도착했습니다. event_type={n['event_type']}"

                _send_mail(email, subject, body)
                supabase.table("notification_queue").update({"status": "sent"}).eq("notification_id", n_id).execute()
                processed += 1
            except Exception as e:
                supabase.table("notification_queue").update(
                    {"status": "failed", "payload": {**(n.get("payload") or {}), "error": str(e)}}
                ).eq("notification_id", n_id).execute()
                failed += 1
        return {"status": "success", "data": {"processed": processed, "failed": failed}}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/admin/stats/trends")
async def admin_stats_trends(authorization: Optional[str] = Header(default=None)):
    _require_admin(authorization)
    rows = (
        supabase.table("repair_requests")
        .select("created_at, status")
        .order("created_at", desc=False)
        .limit(5000)
        .execute()
    )
    all_rows = rows.data or []
    now = datetime.utcnow()

    def _date_key(dt: datetime, unit: str) -> str:
        if unit == "day":
            return dt.strftime("%Y-%m-%d")
        if unit == "week":
            y, w, _ = dt.isocalendar()
            return f"{y}-W{w:02d}"
        return dt.strftime("%Y-%m")

    def _bucketize(days_back: int, unit: str):
        filtered = []
        for r in all_rows:
            try:
                dt = datetime.fromisoformat(str(r["created_at"]).replace("Z", "+00:00")).replace(tzinfo=None)
            except Exception:
                continue
            if (now - dt).days <= days_back:
                filtered.append((dt, r.get("status", "")))
        m = {}
        for dt, status in filtered:
            k = _date_key(dt, unit)
            if k not in m:
                m[k] = {"label": k, "total": 0, "matched": 0, "completed": 0}
            m[k]["total"] += 1
            if status == "matched":
                m[k]["matched"] += 1
            if status == "completed":
                m[k]["completed"] += 1
        return [m[k] for k in sorted(m.keys())]

    return {
        "status": "success",
        "data": {
            "daily": _bucketize(30, "day"),
            "weekly": _bucketize(120, "week"),
            "monthly": _bucketize(365, "month"),
        },
    }


@app.post("/api/admin/requests/{request_id}/status")
async def admin_update_request_status(
    request_id: int,
    body: AdminRequestStatusUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    allowed = ["draft", "requested", "bidding", "matched", "repairing", "completed", "cancelled"]
    if body.status not in allowed:
        raise HTTPException(status_code=400, detail="status 값이 잘못되었습니다.")
    supabase.table("repair_requests").update({"status": body.status}).eq("repair_request_id", request_id).execute()
    _log_admin_action("update_request_status", admin["email"], {"request_id": request_id, "status": body.status})
    return {"status": "success"}


@app.post("/api/admin/requests/{request_id}/match")
async def admin_update_request_match(
    request_id: int,
    body: AdminRequestMatchUpdate,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if len(body.selected_bid_ids) > 2:
        raise HTTPException(status_code=400, detail="최대 2개 업체만 선택 가능합니다.")
    supabase.table("repair_requests").update(
        {
            "selected_bid_ids": body.selected_bid_ids,
            "status": "matched" if body.selected_bid_ids else "bidding",
            "contact_unlocked_at": datetime.utcnow().isoformat() if body.selected_bid_ids else None,
        }
    ).eq("repair_request_id", request_id).execute()
    _log_admin_action(
        "update_request_match",
        admin["email"],
        {"request_id": request_id, "selected_bid_ids": body.selected_bid_ids},
    )
    return {"status": "success"}


@app.api_route("/", methods=["GET", "HEAD"])
def health():
    return {
        "status": "ok",
        "supabase_key_kind": _key_kind(SUPABASE_SERVER_KEY),
        "admin_email_configured": bool(ADMIN_EMAIL),
    }
