import functools
import asyncio
import csv
import difflib
import hashlib
import json
import logging
import smtplib
import os
import re
import random
from collections import defaultdict
import tempfile
import uuid
from datetime import datetime, timedelta
from email.mime.text import MIMEText
from pathlib import Path
from typing import List, Optional

import fitz
import httpx
from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import Client, create_client

app = FastAPI()

NAME_PATTERN = re.compile(r"^[가-힣\s]+$")
COMPANY_PATTERN = re.compile(r"^[가-힣A-Za-z0-9\s().,&\-]+$")
MOBILE_PATTERN = re.compile(r"^010\d{8}$")
OFFICE_PATTERN = re.compile(r"^[0-9+\-()\s]{7,20}$")

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
MASTER_ADMIN_EMAIL = os.environ.get("MASTER_ADMIN_EMAIL", ADMIN_EMAIL).strip().lower()
MASTER_ADMIN_PASSWORD = os.environ.get("MASTER_ADMIN_PASSWORD", "").strip()
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
BASE_DIR = Path(__file__).resolve().parent
ANALYSIS_RULES_PATH = BASE_DIR / "prompts" / "analysis_rules_v1.md"
GUIDE_CSV_PATH = BASE_DIR / "data" / "fixnpass_gem_analysis_mandatory_classify_v2.csv"


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
    if not MASTER_ADMIN_EMAIL:
        raise HTTPException(status_code=500, detail="서버에 MASTER_ADMIN_EMAIL(또는 ADMIN_EMAIL) 설정이 필요합니다.")
    token = _extract_bearer(authorization)
    user_res = supabase.auth.get_user(token)
    user = getattr(user_res, "user", None)
    if not user or not user.email:
        raise HTTPException(status_code=401, detail="유효하지 않은 토큰입니다.")
    email = user.email.lower()
    if email == MASTER_ADMIN_EMAIL:
        return {"id": user.id, "email": email, "is_master": True}
    try:
        ar = (
            supabase.table("admin_roles")
            .select("user_id")
            .eq("user_id", user.id)
            .limit(1)
            .execute()
        )
        if ar.data:
            return {"id": user.id, "email": email, "is_master": False}
    except Exception:
        pass
    raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")


def _bootstrap_master_admin():
    if not (MASTER_ADMIN_EMAIL and MASTER_ADMIN_PASSWORD):
        return
    try:
        users = supabase.auth.admin.list_users(page=1, per_page=1000)
        entries = users if isinstance(users, list) else _unwrap_auth_user_list(users)
        target_id = None
        for u in entries:
            ud = u if isinstance(u, dict) else (u.model_dump() if hasattr(u, "model_dump") else {})
            if str((ud.get("email") or "")).lower() == MASTER_ADMIN_EMAIL:
                target_id = ud.get("id")
                break
        if target_id:
            supabase.auth.admin.update_user_by_id(target_id, {"password": MASTER_ADMIN_PASSWORD})
    except Exception as e:
        logging.warning("master admin bootstrap skipped: %s", str(e))


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


class PendingDraftCleanupBody(BaseModel):
    repair_request_id: int
    user_id: str


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


class AdminGrantRoleBody(BaseModel):
    user_id: str


class AdminBulkRequestAction(BaseModel):
    request_ids: List[int]
    action: str  # hide | delete


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


async def _post_gemini_with_retry(payload: dict, max_attempts: int = 4) -> dict:
    last_error: Optional[str] = None
    for attempt in range(1, max_attempts + 1):
        try:
            async with httpx.AsyncClient(timeout=60.0) as client:
                ai_res = await client.post(GEMINI_URL, json=payload)
            res_json = ai_res.json()
            if "candidates" in res_json:
                return res_json
            msg = res_json.get("error", {}).get("message", "AI 모델 응답 생성 실패")
            last_error = msg
            retryable = ai_res.status_code in [429, 500, 502, 503, 504] or "high demand" in msg.lower()
            if attempt >= max_attempts or not retryable:
                if retryable or "high demand" in msg.lower():
                    raise HTTPException(
                        status_code=503,
                        detail="현재 Gemini 서버 과부하로 분석 요청이 지연되고 있습니다. 잠시 후 다시 시도해주세요.",
                    )
                raise HTTPException(status_code=500, detail=f"AI 분석 실패: {msg}")
        except HTTPException:
            raise
        except Exception as e:
            last_error = str(e)
            if attempt >= max_attempts:
                break
        base = 0.8 * (2 ** (attempt - 1))
        await asyncio.sleep(base + random.uniform(0.15, 1.1))
    err = (last_error or "").lower()
    if "high demand" in err or "429" in err or "503" in err:
        raise HTTPException(
            status_code=503,
            detail="현재 Gemini 서버 과부하로 분석 요청이 지연되고 있습니다. 잠시 후 다시 시도해주세요.",
        )
    raise HTTPException(status_code=500, detail=f"AI 분석 실패: {last_error or '일시적 오류'}")


def _validate_profile_fields(name: Optional[str], company_name: Optional[str], phone_number: Optional[str], office_phone_number: Optional[str]):
    if name is not None and name.strip() and not NAME_PATTERN.fullmatch(name.strip()):
        raise HTTPException(status_code=400, detail="이름은 한글만 입력 가능합니다.")
    if company_name is not None and company_name.strip() and not COMPANY_PATTERN.fullmatch(company_name.strip()):
        raise HTTPException(status_code=400, detail="상호 형식이 올바르지 않습니다.")
    if phone_number is not None:
        d = _normalize_phone(phone_number)
        if d and not MOBILE_PATTERN.fullmatch(d):
            raise HTTPException(status_code=400, detail="휴대폰 번호는 010으로 시작하는 11자리여야 합니다.")
    if office_phone_number is not None and str(office_phone_number).strip():
        if not OFFICE_PATTERN.fullmatch(str(office_phone_number).strip()):
            raise HTTPException(status_code=400, detail="사무실 전화번호 형식이 올바르지 않습니다.")


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
        "draft": "견적 요청 비정상",
        "requested": "신규요청(견적 대기)",
        "bidding": "견적 진행중",
        "matched": "업체 선정 완료",
        "repairing": "현장 진행중",
        "completed": "작업 완료",
        "cancelled": "취소됨",
    }
    return mapping.get(status, status)


def _load_analysis_rules_text() -> str:
    try:
        return ANALYSIS_RULES_PATH.read_text(encoding="utf-8")
    except Exception:
        return ""


@functools.lru_cache(maxsize=1)
def _load_guide_rows() -> list[dict]:
    rows = []
    if not GUIDE_CSV_PATH.exists():
        return rows
    try:
        with GUIDE_CSV_PATH.open("r", encoding="utf-8-sig", newline="") as f:
            reader = csv.DictReader(f)
            for r in reader:
                aliases = []
                for i in range(1, 8):
                    v = (r.get(f"부적합 항목명{i}") or "").strip()
                    if v:
                        aliases.append(v)
                comment = (r.get("가이드 코멘트") or "").strip()
                if aliases and comment:
                    rows.append({"aliases": aliases, "guide_comment": comment})
    except Exception:
        return []
    return rows


def _match_guide_comment(item: str) -> dict:
    t = re.sub(r"\s+", "", (item or "").lower())
    if not t:
        return {"guide_comment": None, "matched_alias": None, "guide_comments": [], "matched_aliases": []}
    matched_comments: list[str] = []
    matched_aliases: list[str] = []
    scored_candidates: list[tuple[float, str, str]] = []
    for row in _load_guide_rows():
        for alias in row["aliases"]:
            a = re.sub(r"\s+", "", alias.lower())
            if not a:
                continue
            if a in t or t in a:
                matched_comments.append(row["guide_comment"])
                matched_aliases.append(alias)
                continue
            # 완전 포함이 아니면 문자열 유사도 기반으로 완화 매칭
            score = difflib.SequenceMatcher(None, t, a).ratio()
            if score >= 0.62:
                scored_candidates.append((score, row["guide_comment"], alias))
    if scored_candidates:
        scored_candidates.sort(key=lambda x: x[0], reverse=True)
        top_n = scored_candidates[:3]
        for _, comment, alias in top_n:
            matched_comments.append(comment)
            matched_aliases.append(alias)
    uniq_comments = list(dict.fromkeys([c for c in matched_comments if c]))
    uniq_aliases = list(dict.fromkeys([a for a in matched_aliases if a]))
    return {
        "guide_comment": " / ".join(uniq_comments) if uniq_comments else None,
        "matched_alias": ", ".join(uniq_aliases) if uniq_aliases else None,
        "guide_comments": uniq_comments,
        "matched_aliases": uniq_aliases,
    }


def _clean_text(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()


def _pdf_pages_text(pdf_bytes: bytes) -> list[str]:
    d = fitz.open(stream=pdf_bytes, filetype="pdf")
    out = [d.load_page(i).get_text() or "" for i in range(len(d))]
    d.close()
    return out


def _pdf_concat(pdf_list: list[bytes]) -> bytes:
    dst = fitz.open()
    for b in pdf_list:
        src = fitz.open(stream=b, filetype="pdf")
        dst.insert_pdf(src)
        src.close()
    out = dst.tobytes()
    dst.close()
    return out


def _document_fingerprint(comprehensive_text: str, visual_text: str) -> str:
    # 텍스트 원문 동일성 기준(파일명 무관)으로 판단
    raw = f"{comprehensive_text}\n<<VISUAL_BRIEFING>>\n{visual_text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _has_open_duplicate_fingerprint(fingerprint: str) -> bool:
    now_iso = datetime.utcnow().isoformat() + "Z"
    rows = (
        supabase.table("repair_requests")
        .select("repair_request_id, status, quote_deadline_at, parsed_data")
        .in_("status", ["requested", "bidding", "matched", "repairing", "completed"])
        .gt("quote_deadline_at", now_iso)
        .execute()
    )
    for r in rows.data or []:
        parsed = r.get("parsed_data") or {}
        if isinstance(parsed, dict) and parsed.get("document_fingerprint") == fingerprint:
            return True
    return False


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
                "견적 제출 업체들은 보수업을 정식으로 등록하고 법정 보수원 교육을 이수한 업체입니다.\n\n"
                "내 요청 내역에서 상세 견적을 확인해 주세요."
            )
        elif event_type == "request_submitted_notice":
            subject = "[Fix&Pass] 견적 요청이 접수되었습니다"
            body = (
                "요청하신 견적이 정상 접수되었습니다.\n\n"
                f"- 수리요청 ID: {payload.get('repair_request_id')}\n\n"
                "견적 제출 업체들은 보수업을 정식으로 등록하고 법정 보수원 교육을 이수한 업체입니다.\n"
                "내 요청 내역에서 접수 상태를 확인해 주세요."
            )
        else:
            subject = "[Fix&Pass] 알림"
            body = f"새 알림이 도착했습니다. event_type={event_type}"
        _send_mail(email, subject, body)
        if n_id:
            supabase.table("notification_queue").update({"status": "sent"}).eq("notification_id", n_id).execute()
    except Exception as e:
        logging.warning("immediate mail send failed: %s", str(e))


def _build_masked_pdf(original_pdf_bytes: bytes, ai_data: dict, extra_sensitive_terms: Optional[list[str]] = None) -> bytes:
    """
    원본 PDF 레이아웃/사진은 유지하고, 민감 텍스트만 가린 업체용 PDF를 생성한다.
    """
    doc = fitz.open(stream=original_pdf_bytes, filetype="pdf")
    full_text = ""
    for p in doc:
        full_text += p.get_text() + "\n"

    site_info = ai_data.get("site_info", {}) or {}
    address_info = site_info.get("address", {}) if isinstance(site_info, dict) else {}
    parking_info = site_info.get("parking", {}) if isinstance(site_info, dict) else {}

    sensitive_terms = [
        str(ai_data.get("building_name", "")).strip(),
        str(ai_data.get("region_summary", "")).strip(),
        str(ai_data.get("address_detail", "")).strip(),
        str(address_info.get("building_name", "")).strip(),
        str(address_info.get("region_summary", "")).strip(),
        str(address_info.get("address_detail", "")).strip(),
        str(address_info.get("manager_name", "")).strip(),
    ]
    if extra_sensitive_terms:
        sensitive_terms.extend(extra_sensitive_terms)
    # 비주얼브리핑 일반사항 라벨-값 기반 마스킹(라벨은 유지, 값만 마스킹)
    sensitive_terms.extend(_extract_general_section_sensitive_terms(full_text))
    # 종합의견서/기타 레이아웃 대응용 보수적 라인 기반 보조 마스킹
    sensitive_terms.extend(_collect_sensitive_from_lines(full_text))
    # 텍스트에서 직접 추출 가능한 식별 패턴 마스킹
    sensitive_terms += re.findall(r"\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b", full_text)
    sensitive_terms += re.findall(r"\b0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}\b", full_text)
    sensitive_terms += re.findall(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", full_text)
    sensitive_terms += re.findall(r"\b\d{6}[-\s]?\d{7}\b", full_text)
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


def _classify_report_kind(text: str) -> str:
    t = re.sub(r"\s+", "", (text or "")).lower()
    has_comprehensive = "종합의견서" in t
    has_visual = ("검사결과의견" in t and "이미지파일" in t) or ("비주얼브리핑" in t)
    if has_comprehensive and has_visual:
        return "combined"
    if has_comprehensive:
        return "comprehensive"
    if has_visual:
        return "visual"
    return "unknown"


def _split_comprehensive_before_wire(pdf_bytes: bytes) -> bytes:
    src = fitz.open(stream=pdf_bytes, filetype="pdf")
    keep_until = len(src)
    for i in range(len(src)):
        page_text = src.load_page(i).get_text() or ""
        if "와이어로프 테스터 측정 결과" in page_text or "와이어로프테스터측정결과" in re.sub(r"\s+", "", page_text):
            keep_until = i
            break
    out = fitz.open()
    if keep_until <= 0:
        out.insert_pdf(src, from_page=0, to_page=0)
    else:
        out.insert_pdf(src, from_page=0, to_page=max(0, keep_until - 1))
    b = out.tobytes()
    out.close()
    src.close()
    return b


def _safe_dict(obj) -> dict:
    return obj if isinstance(obj, dict) else {}


def _collect_sensitive_from_lines(full_text: str) -> list[str]:
    lines = [x.strip() for x in (full_text or "").splitlines() if x.strip()]
    out: list[str] = []
    markers = ["건물명", "소재지", "주소", "상세주소", "관리자", "검사자", "인증번호", "보수사", "보수업체", "연락처", "전화번호"]
    for line in lines:
        normalized = re.sub(r"\s+", "", line)
        if any(m in normalized for m in markers):
            out.append(line)
            for sep in [":", "："]:
                if sep in line:
                    out.append(line.split(sep, 1)[1].strip())
    for token in re.split(r"[\s,()/\-]+", " ".join(out)):
        t = token.strip()
        if len(t) >= 2:
            out.append(t)
    return [x for x in out if x]


def _extract_general_section_sensitive_terms(full_text: str) -> list[str]:
    """
    비주얼브리핑의 `1. 일반사항` 구간에서 라벨-값 형태를 파싱해
    민감 값(라벨은 제외)만 추출한다.
    """
    text = full_text or ""
    start = text.find("1. 일반사항")
    if start < 0:
        return []
    end = text.find("2. 이미지파일", start)
    section = text[start:end] if end > start else text[start:]
    raw_lines = [ln.strip() for ln in section.splitlines() if ln.strip()]
    if not raw_lines:
        return []

    labels = {
        "주소",
        "소재지",
        "건물명",
        "관리자",
        "연락처",
        "인증번호",
        "보수사",
        "검사자",
        "관리자성명",
        "검사자성명",
    }
    all_known_labels = labels | {
        "종류및방식",
        "제작사",
        "검사일자",
        "승강기대수",
    }

    values: list[str] = []
    current_label: Optional[str] = None
    current_value_lines: list[str] = []

    def flush():
        nonlocal current_label, current_value_lines
        if current_label in labels and current_value_lines:
            values.extend(current_value_lines)
        current_label = None
        current_value_lines = []

    for line in raw_lines:
        normalized = re.sub(r"\s+", "", line)
        if normalized in all_known_labels:
            flush()
            current_label = normalized
            continue
        if current_label:
            current_value_lines.append(line)
    flush()

    expanded = list(values)
    for v in values:
        for token in re.split(r"[\s,()/\-]+", v):
            t = token.strip()
            if len(t) >= 2:
                expanded.append(t)
    return [x for x in expanded if x]


async def _extract_doc_signature(text: str, label: str) -> dict:
    prompt = f"""
아래는 {label} 텍스트입니다.
아래 스키마로 JSON만 반환하세요.
{{
  "building_name": "string",
  "region_summary": "string",
  "address_detail": "string",
  "mandatory_items": ["string"]
}}
텍스트:
{text[:12000]}
"""
    res_json = await _post_gemini_with_retry({"contents": [{"parts": [{"text": prompt}]}]})
    ai_raw = res_json["candidates"][0]["content"]["parts"][0]["text"]
    if "```" in ai_raw:
        ai_raw = ai_raw.split("```")[1].replace("json", "").strip().split("```")[0].strip()
    parsed = json.loads(ai_raw)
    return {
        "building_name": _clean_text(parsed.get("building_name") or ""),
        "region_summary": _normalize_region_summary(parsed.get("region_summary") or ""),
        "address_detail": _clean_text(parsed.get("address_detail") or ""),
        "mandatory_items": [str(x).strip() for x in (parsed.get("mandatory_items") or []) if str(x).strip()],
    }


async def _is_same_case_documents(comprehensive_text: str, visual_text: str) -> bool:
    sig_c = await _extract_doc_signature(comprehensive_text, "종합의견서")
    sig_v = await _extract_doc_signature(visual_text, "비주얼브리핑")
    c_name = re.sub(r"\s+", "", sig_c.get("building_name", ""))
    v_name = re.sub(r"\s+", "", sig_v.get("building_name", ""))
    if not c_name or not v_name:
        return False
    name_ok = (c_name in v_name or v_name in c_name) or difflib.SequenceMatcher(None, c_name, v_name).ratio() >= 0.6
    return bool(name_ok)


def _extract_with_llm(comprehensive_text: str, visual_text: str) -> dict:
    rules = _load_analysis_rules_text()
    prompt = f"""
다음은 기계식 주차장 검사 문서 분석 작업입니다.
아래 규칙을 가능한 한 준수하되, 응답은 반드시 순수 JSON 객체 하나로만 반환하세요.

[규칙]
{rules[:14000]}

[출력 JSON 스키마]
{{
  "site_info": {{
    "address": {{
      "building_name": "string",
      "region_summary": "string",
      "address_detail": "string"
    }},
    "parking": {{
      "parking_type": "string",
      "manufacturer": "string"
    }}
  }},
  "mandatory_repairs": [{{"item":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "optional_repairs": [{{"item":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "reference_notes": [{{"note":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "redaction_summary": {{"targets":["string"],"reason":"string"}},
  "documents": {{"has_comprehensive": true, "has_visual": true}}
}}

[종합의견서 텍스트]
{comprehensive_text[:22000]}

[비주얼브리핑 텍스트]
{visual_text[:22000]}
"""
    res_json = asyncio.get_event_loop().run_until_complete(
        _post_gemini_with_retry({"contents": [{"parts": [{"text": prompt}]}]})
    )
    ai_raw = res_json["candidates"][0]["content"]["parts"][0]["text"]
    if "```" in ai_raw:
        ai_raw = ai_raw.split("```")[1].replace("json", "").strip().split("```")[0].strip()
    return json.loads(ai_raw)


@app.post("/api/upload-pdf")
async def upload_pdf(
    requester_id: Optional[str] = None,
    file: Optional[UploadFile] = File(None),
    files: Optional[List[UploadFile]] = File(None),
):
    _rate_limit("upload_pdf", requester_id or "guest")
    if requester_id:
        _require_active_role(requester_id, ["requester"], "requester")
    req_token = str(uuid.uuid4())
    owner_key = requester_id or "guest"
    original_path = f"requester/{owner_key}/{req_token}/original.pdf"
    masked_path = f"request/{req_token}/masked.pdf"
    upload_files = [f for f in (files or []) if f is not None]
    if file:
        upload_files.append(file)
    if not upload_files:
        raise HTTPException(status_code=400, detail="PDF 파일을 1개 또는 2개 업로드해주세요.")
    if len(upload_files) > 2:
        raise HTTPException(status_code=400, detail="PDF는 최대 2개까지 업로드할 수 있습니다.")

    pdf_payloads: list[tuple[str, bytes]] = []
    for f in upload_files:
        b = await f.read()
        if not b:
            continue
        pdf_payloads.append((f.filename or "upload.pdf", b))
    if not pdf_payloads:
        raise HTTPException(status_code=400, detail="유효한 PDF 파일을 찾을 수 없습니다.")
    try:
        comprehensive_bytes: Optional[bytes] = None
        visual_bytes: Optional[bytes] = None
        full_input_bytes: list[bytes] = []
        for _, pdf_bytes in pdf_payloads:
            full_input_bytes.append(pdf_bytes)
            page_texts = _pdf_pages_text(pdf_bytes)
            joined = "\n".join(page_texts[:6])
            kind = _classify_report_kind(joined)
            if kind == "combined":
                comprehensive_bytes = _split_comprehensive_before_wire(pdf_bytes)
                visual_bytes = pdf_bytes
            elif kind == "comprehensive":
                comprehensive_bytes = pdf_bytes
            elif kind == "visual":
                visual_bytes = pdf_bytes

        if not comprehensive_bytes and not visual_bytes and len(pdf_payloads) == 1:
            one_text = "\n".join(_pdf_pages_text(pdf_payloads[0][1])[:8])
            kind = _classify_report_kind(one_text)
            if kind == "unknown":
                raise HTTPException(
                    status_code=400,
                    detail="업로드한 PDF에서 종합의견서/비주얼브리핑을 확인하지 못했습니다. 문서를 다시 확인해주세요.",
                )
        if not comprehensive_bytes:
            raise HTTPException(
                status_code=400,
                detail="종합의견서도 함께 업로드가 필요합니다. 필요시 한국교통안전공단에 요청해주세요.",
            )
        if not visual_bytes:
            raise HTTPException(
                status_code=400,
                detail="비주얼브리핑도 함께 업로드가 필요합니다. 필요시 한국교통안전공단에 요청해주세요.",
            )

        comprehensive_text = "\n".join(_pdf_pages_text(comprehensive_bytes))
        visual_text = "\n".join(_pdf_pages_text(visual_bytes))
        fingerprint = _document_fingerprint(comprehensive_text, visual_text)
        if _has_open_duplicate_fingerprint(fingerprint):
            raise HTTPException(
                status_code=409,
                detail=(
                    "동일한 견적서로 이미 진행 중인 요청이 있어 마감기한 전에는 다시 요청할 수 없습니다. "
                    "기존 요청 마감 후 다시 시도하거나, 기존 요청을 삭제한 뒤 재등록해주세요."
                ),
            )
        should_check_pair_consistency = len(pdf_payloads) >= 2
        if should_check_pair_consistency and not await _is_same_case_documents(comprehensive_text, visual_text):
            raise HTTPException(
                status_code=400,
                detail="같은 건에 대해 제공된 종합의견서와 비주얼브리핑을 업로드 해주세요.",
            )
        merged_original = _pdf_concat(full_input_bytes)
        supabase.storage.from_(ORIGINAL_BUCKET).upload(
            path=original_path,
            file=merged_original,
            file_options={"content-type": "application/pdf"},
        )
        rules = _load_analysis_rules_text()
        prompt = f"""
다음은 기계식 주차장 검사 문서 분석 작업입니다.
아래 규칙을 가능한 한 준수하되, 응답은 반드시 순수 JSON 객체 하나로만 반환하세요.

[규칙]
{rules[:14000]}

[출력 JSON 스키마]
{{
  "site_info": {{
    "address": {{
      "building_name": "string",
      "region_summary": "string",
      "address_detail": "string"
    }},
    "parking": {{
      "parking_type": "string",
      "manufacturer": "string",
      "elevator_count": "string"
    }}
  }},
  "mandatory_repairs": [{{"item":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "optional_repairs": [{{"item":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "reference_notes": [{{"note":"string","reason":"string","source_pages":[1],"source_document":"종합의견서|비주얼브리핑"}}],
  "redaction_summary": {{"targets":["string"],"reason":"string"}},
  "documents": {{"has_comprehensive": true, "has_visual": true}}
}}

[종합의견서 텍스트]
{comprehensive_text[:22000]}

[비주얼브리핑 텍스트]
{visual_text[:22000]}
"""
        res_json = await _post_gemini_with_retry({"contents": [{"parts": [{"text": prompt}]}]})
        ai_raw = res_json["candidates"][0]["content"]["parts"][0]["text"]
        if "```" in ai_raw:
            ai_raw = ai_raw.split("```")[1].replace("json", "").strip().split("```")[0].strip()
        ai_data = json.loads(ai_raw)

        site_info = _safe_dict(ai_data.get("site_info"))
        addr = _safe_dict(site_info.get("address"))
        park = _safe_dict(site_info.get("parking"))
        building_name = _clean_text(addr.get("building_name") or ai_data.get("building_name") or "건물명 미확인")
        region_summary = _normalize_region_summary(addr.get("region_summary") or ai_data.get("region_summary") or "위치 미확인")
        address_detail = _clean_text(addr.get("address_detail") or ai_data.get("address_detail") or "")
        parking_type = _clean_text(park.get("parking_type") or ai_data.get("parking_type") or "기종 확인 불가")
        manufacturer = _clean_text(park.get("manufacturer") or "")
        elevator_count = _clean_text(park.get("elevator_count") or ai_data.get("elevator_count") or "")

        def _normalize_repair_items(items, key_name="item"):
            out = []
            for item in items or []:
                if isinstance(item, str):
                    entry = {"item": _clean_text(item), "reason": "", "source_pages": [], "source_document": ""}
                elif isinstance(item, dict):
                    entry = {
                        "item": _clean_text(item.get(key_name) or item.get("item") or item.get("name") or ""),
                        "reason": _clean_text(item.get("reason") or item.get("basis") or ""),
                        "source_pages": item.get("source_pages") if isinstance(item.get("source_pages"), list) else [],
                        "source_document": _clean_text(item.get("source_document") or ""),
                    }
                else:
                    continue
                if not entry["item"]:
                    continue
                guide = _match_guide_comment(entry["item"])
                entry["guide_comment"] = guide["guide_comment"]
                entry["matched_alias"] = guide["matched_alias"]
                entry["guide_comments"] = guide.get("guide_comments", [])
                entry["matched_aliases"] = guide.get("matched_aliases", [])
                out.append(entry)
            return out

        mandatory_repairs = _normalize_repair_items(ai_data.get("mandatory_repairs", []))
        optional_repairs = _normalize_repair_items(ai_data.get("optional_repairs", []))
        reference_notes = []
        for n in ai_data.get("reference_notes", []) or []:
            if isinstance(n, str):
                reference_notes.append({"note": _clean_text(n), "reason": "", "source_pages": [], "source_document": ""})
            elif isinstance(n, dict):
                reference_notes.append(
                    {
                        "note": _clean_text(n.get("note") or n.get("item") or ""),
                        "reason": _clean_text(n.get("reason") or ""),
                        "source_pages": n.get("source_pages") if isinstance(n.get("source_pages"), list) else [],
                        "source_document": _clean_text(n.get("source_document") or ""),
                    }
                )

        redaction_targets = list(
            dict.fromkeys(
                [
                    building_name,
                    region_summary,
                    address_detail,
                    "관리자",
                    "담당자",
                    "검사자",
                    "보수업체",
                    "보수사",
                    "연락처",
                    "전화번호",
                    "인증번호",
                ]
            )
        )
        masked_bytes = _build_masked_pdf(
            _pdf_concat([_split_comprehensive_before_wire(comprehensive_bytes), visual_bytes]),
            {"site_info": {"address": {"building_name": building_name, "region_summary": region_summary, "address_detail": address_detail}, "parking": {"parking_type": parking_type, "manufacturer": manufacturer, "elevator_count": elevator_count}}},
            extra_sensitive_terms=redaction_targets,
        )
        supabase.storage.from_(MASKED_BUCKET).upload(
            path=masked_path,
            file=masked_bytes,
            file_options={"content-type": "application/pdf"},
        )

        parsed_data = {
            "documents": {"has_comprehensive": True, "has_visual": True},
            "site_info": {
                "address": {
                    "building_name": building_name,
                    "region_summary": region_summary,
                    "address_detail": address_detail,
                },
                "parking": {
                    "parking_type": parking_type,
                    "manufacturer": manufacturer,
                    "elevator_count": elevator_count,
                },
            },
            "mandatory_repairs": mandatory_repairs,
            "optional_repairs": optional_repairs,
            "reference_notes": reference_notes,
            "redaction_summary": {
                "targets": redaction_targets,
                "reason": "서비스 외 개인 접촉 가능성이 있는 식별 정보를 보수적으로 가림 처리",
            },
            "document_fingerprint": fingerprint,
            "mandatory": [x["item"] for x in mandatory_repairs],
            "optional": [x["item"] for x in optional_repairs],
        }

        insert_data = {
            "status": "draft",
            "region_summary": region_summary or "위치 미확인",
            "address_detail": address_detail,
            "building_name": building_name,
            "parking_type": parking_type,
            "original_pdf_path": original_path,
            "masked_pdf_path": masked_path,
            "parsed_data": parsed_data,
            "selected_items": [x["item"] for x in mandatory_repairs],
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
        pass


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
        if req.status == "requested":
            requester_profile = _get_profile(req.requester_id) or {}
            requester_name = requester_profile.get("name") or "수리요청인"
            try:
                _enqueue_and_maybe_send(
                    "request_submitted_notice",
                    req.requester_id,
                    {
                        "repair_request_id": req.repair_request_id,
                        "requester_name": requester_name,
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


@app.post("/api/pending-quote/discard-draft")
async def discard_pending_quote_draft(body: PendingDraftCleanupBody):
    try:
        profile = _get_profile(body.user_id)
        if not profile or profile.get("role") != "contractor":
            raise HTTPException(status_code=403, detail="수리업체만 접근할 수 있습니다.")
        req_res = (
            supabase.table("repair_requests")
            .select("repair_request_id, status, requester_id, original_pdf_path, masked_pdf_path")
            .eq("repair_request_id", body.repair_request_id)
            .limit(1)
            .execute()
        )
        if not req_res.data:
            return {"status": "success", "deleted": False}
        req_row = req_res.data[0]
        if req_row.get("status") != "draft":
            return {"status": "success", "deleted": False}
        # 게스트 분석 임시건만 삭제 허용
        if req_row.get("requester_id"):
            return {"status": "success", "deleted": False}
        try:
            if req_row.get("original_pdf_path"):
                supabase.storage.from_(ORIGINAL_BUCKET).remove([req_row["original_pdf_path"]])
        except Exception:
            pass
        try:
            if req_row.get("masked_pdf_path"):
                supabase.storage.from_(MASKED_BUCKET).remove([req_row["masked_pdf_path"]])
        except Exception:
            pass
        supabase.table("bids").delete().eq("repair_request_id", body.repair_request_id).execute()
        supabase.table("repair_requests").delete().eq("repair_request_id", body.repair_request_id).execute()
        return {"status": "success", "deleted": True}
    except HTTPException as e:
        raise e
    except Exception as e:
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


@app.get("/api/regions/open-demand")
async def open_region_demand(sido: str):
    try:
        prefix = (sido or "").strip()
        if not prefix:
            return {"status": "success", "data": {}}
        now_iso = datetime.utcnow().isoformat() + "Z"
        rows = (
            supabase.table("repair_requests")
            .select("region_summary, status, quote_deadline_at, selected_bid_ids, is_hidden")
            .ilike("region_summary", f"{prefix}%")
            .in_("status", ["requested", "bidding"])
            .order("created_at", desc=True)
            .limit(1000)
            .execute()
        )
        counts: dict[str, int] = {}
        for r in rows.data or []:
            if r.get("is_hidden"):
                continue
            selected = r.get("selected_bid_ids") or []
            if isinstance(selected, list) and len(selected) > 0:
                continue
            dl = r.get("quote_deadline_at")
            if dl and str(dl) < now_iso:
                continue
            region = _normalize_region_summary(str(r.get("region_summary") or "").strip())
            if not region.startswith(f"{prefix} "):
                continue
            counts[region] = counts.get(region, 0) + 1
        return {"status": "success", "data": counts}
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
        _validate_profile_fields(body.name, body.company_name, body.phone_number, body.office_phone_number)
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
        if status == "draft":
            detail_res = (
                supabase.table("repair_requests")
                .select("original_pdf_path, masked_pdf_path")
                .eq("repair_request_id", request_id)
                .limit(1)
                .execute()
            )
            row = detail_res.data[0] if detail_res.data else {}
            try:
                if row.get("original_pdf_path"):
                    supabase.storage.from_(ORIGINAL_BUCKET).remove([row["original_pdf_path"]])
            except Exception:
                pass
            try:
                if row.get("masked_pdf_path"):
                    supabase.storage.from_(MASKED_BUCKET).remove([row["masked_pdf_path"]])
            except Exception:
                pass
            supabase.table("bids").delete().eq("repair_request_id", request_id).execute()
            supabase.table("repair_requests").delete().eq("repair_request_id", request_id).execute()
            return {"status": "success"}
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
    except HTTPException as e:
        raise e
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
    mine: Optional[str] = None
    is_admin = False
    if authorization:
        try:
            mine = _require_authenticated_user(authorization)["id"]
            try:
                _require_admin(authorization)
                is_admin = True
            except Exception:
                is_admin = False
        except HTTPException:
            mine = None
    q = (
        supabase.table("inquiries")
        .select("id, title, created_at, author_id")
        .order("created_at", desc=True)
        .limit(100)
    )
    if not is_admin:
        if not mine:
            return {"status": "success", "data": []}
        q = q.eq("author_id", mine)
    res = q.execute()
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
    if not is_mine and not is_admin_session:
        raise HTTPException(status_code=403, detail="본인 문의만 조회할 수 있습니다.")
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


_bootstrap_master_admin()


@app.get("/api/admin/auth-users")
async def admin_list_auth_users(authorization: Optional[str] = Header(default=None)):
    admin_ctx = _require_admin(authorization)
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
    partner_profile_by_id: dict = {}
    if ids:
        pres = (
            supabase.table("profiles")
            .select("id, role, is_active, name, phone_number, office_phone_number, company_name, created_at")
            .in_("id", ids)
            .execute()
        )
        for p in pres.data or []:
            profiles_by_id[str(p["id"])] = p
        pprof = (
            supabase.table("partner_profiles")
            .select("partner_id, business_location")
            .in_("partner_id", ids)
            .execute()
        )
        for p in pprof.data or []:
            partner_profile_by_id[str(p.get("partner_id"))] = p

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
        pprof = partner_profile_by_id.get(uid, {})
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
                "business_location": pprof.get("business_location"),
                "role": prof.get("role"),
                "is_active": prof.get("is_active", True),
                "profile_created_at": prof.get("created_at"),
                "is_master_admin": bool(email and str(email).lower() == MASTER_ADMIN_EMAIL),
                "is_admin": False,
            }
        )
    role_rows = supabase.table("admin_roles").select("user_id").execute().data or []
    admin_set = {str(x.get("user_id")) for x in role_rows}
    for row in out:
        if row["is_master_admin"]:
            row["is_admin"] = True
            row["role_display"] = "Master Admin"
        elif row["id"] in admin_set:
            row["is_admin"] = True
            row["role_display"] = "Administrator"
        else:
            row["role_display"] = "수리 업체" if row.get("role") == "contractor" else "수리 의뢰인"
    # Non-master admin cannot enumerate master metadata details beyond listing.
    if not admin_ctx.get("is_master"):
        for row in out:
            if row.get("is_master_admin"):
                row["role_display"] = "Master Admin"
    out.sort(key=lambda x: (x.get("email") or "").lower())
    return {"status": "success", "data": out}


@app.get("/api/admin/session")
async def get_admin_session(authorization: Optional[str] = Header(default=None)):
    admin = _require_admin(authorization)
    return {
        "status": "success",
        "data": {
            "is_admin": True,
            "is_master": bool(admin.get("is_master")),
            "allowed_tabs": ["requests", "inquiries", "ops", "stats"] if admin.get("is_master") else ["requests", "inquiries"],
            "email": admin.get("email"),
        },
    }


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


@app.get("/api/admin/requests")
async def admin_requests(
    authorization: Optional[str] = Header(default=None),
    status: Optional[str] = None,
    include_hidden: bool = True,
):
    _require_admin(authorization)
    q = (
        supabase.table("repair_requests")
        .select(
            "repair_request_id, status, created_at, building_name, region_summary, requester_id, "
            "selected_bid_ids, quote_deadline_at, is_hidden"
        )
        .order("created_at", desc=True)
        .limit(300)
    )
    if status and status != "ALL":
        q = q.eq("status", status)
    if not include_hidden:
        q = q.eq("is_hidden", False)
    reqs = q.execute().data or []
    requester_ids = [r["requester_id"] for r in reqs if r.get("requester_id")]
    req_ids = [r["repair_request_id"] for r in reqs]
    prof_map = {}
    bids_map = defaultdict(list)
    if requester_ids:
        pres = (
            supabase.table("profiles")
            .select("id, name, is_active")
            .in_("id", requester_ids)
            .execute()
        )
        prof_map = {p["id"]: p for p in (pres.data or [])}
    if req_ids:
        bres = (
            supabase.table("bids")
            .select("repair_request_id, bid_id, partner_id, bid_amount, profiles(company_name,name)")
            .in_("repair_request_id", req_ids)
            .execute()
        )
        for b in bres.data or []:
            pn = ((b.get("profiles") or {}).get("company_name") or (b.get("profiles") or {}).get("name") or "").strip()
            bids_map[b["repair_request_id"]].append(
                {"bid_id": b.get("bid_id"), "partner_id": b.get("partner_id"), "company_name": pn, "bid_amount": b.get("bid_amount")}
            )
    out = []
    for r in reqs:
        rp = prof_map.get(r.get("requester_id"), {})
        out.append(
            {
                **r,
                "requester_name": rp.get("name"),
                "requester_active": rp.get("is_active", True),
                "bid_companies": [x.get("company_name") for x in bids_map.get(r["repair_request_id"], []) if x.get("company_name")],
                "bids": bids_map.get(r["repair_request_id"], []),
            }
        )
    return {"status": "success", "data": out}


@app.post("/api/admin/requests/bulk-action")
async def admin_bulk_requests_action(
    body: AdminBulkRequestAction,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    ids = list(dict.fromkeys([int(x) for x in (body.request_ids or [])]))
    if not ids:
        raise HTTPException(status_code=400, detail="처리할 request_ids가 비어 있습니다.")
    if body.action not in ["hide", "delete"]:
        raise HTTPException(status_code=400, detail="action은 hide 또는 delete 여야 합니다.")
    targets = (
        supabase.table("repair_requests")
        .select("repair_request_id, requester_id, original_pdf_path, masked_pdf_path")
        .in_("repair_request_id", ids)
        .execute()
    ).data or []
    deleted = 0
    hidden = 0
    for t in targets:
        rid = t["repair_request_id"]
        should_hide = body.action == "hide"
        if body.action == "delete" and t.get("requester_id"):
            p = _get_profile(t["requester_id"]) or {}
            if not p.get("is_active", True):
                should_hide = True
        if should_hide:
            supabase.table("repair_requests").update({"is_hidden": True}).eq("repair_request_id", rid).execute()
            hidden += 1
            continue
        try:
            if t.get("original_pdf_path"):
                supabase.storage.from_(ORIGINAL_BUCKET).remove([t["original_pdf_path"]])
            if t.get("masked_pdf_path"):
                supabase.storage.from_(MASKED_BUCKET).remove([t["masked_pdf_path"]])
        except Exception:
            pass
        supabase.table("bids").delete().eq("repair_request_id", rid).execute()
        supabase.table("repair_requests").delete().eq("repair_request_id", rid).execute()
        deleted += 1
    _log_admin_action("bulk_request_action", admin["email"], {"action": body.action, "count": len(ids), "deleted": deleted, "hidden": hidden})
    return {"status": "success", "data": {"requested": len(ids), "deleted": deleted, "hidden": hidden}}


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


@app.post("/api/admin/master/grant-admin")
async def admin_master_grant_admin(
    body: AdminGrantRoleBody,
    authorization: Optional[str] = Header(default=None),
):
    admin = _require_admin(authorization)
    if not admin.get("is_master"):
        raise HTTPException(status_code=403, detail="마스터 관리자만 권한을 부여할 수 있습니다.")
    uid = body.user_id.strip()
    if not uid:
        raise HTTPException(status_code=400, detail="user_id가 필요합니다.")
    supabase.table("admin_roles").upsert({"user_id": uid, "granted_by": admin["email"]}).execute()
    _log_admin_action("grant_admin_role", admin["email"], {"user_id": uid})
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
