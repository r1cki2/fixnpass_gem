import json
import logging
import os
import re
import tempfile
import uuid
from datetime import datetime
from typing import List, Optional

import fitz
import httpx
from fastapi import FastAPI, File, Header, HTTPException, UploadFile
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


class MyProfileUpdate(BaseModel):
    user_id: str
    role: Optional[str] = None
    name: Optional[str] = None
    phone_number: Optional[str] = None
    company_name: Optional[str] = None
    business_location: Optional[str] = None
    service_regions: Optional[List[str]] = None
    years_experience: Optional[int] = None
    employee_count: Optional[int] = None
    intro: Optional[str] = None


def _safe_list(v):
    return v if isinstance(v, list) else []


def _get_profile(user_id: str) -> Optional[dict]:
    try:
        profile_res = (
            supabase.table("profiles")
            .select("role, is_active, name, phone_number, company_name")
            .eq("id", user_id)
            .limit(1)
            .execute()
        )
    except Exception:
        # Backward compatibility when is_active column is not created yet.
        profile_res = (
            supabase.table("profiles")
            .select("role, name, phone_number, company_name")
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
            "region_summary": ai_data.get("region_summary", "위치 미확인"),
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
            .select("repair_request_id, requester_id")
            .eq("repair_request_id", req.repair_request_id)
            .execute()
        )
        if not existing.data:
            raise HTTPException(status_code=404, detail="요청 건을 찾을 수 없습니다.")
        current_requester = existing.data[0].get("requester_id")
        if current_requester and current_requester != req.requester_id:
            raise HTTPException(status_code=403, detail="권한이 없습니다.")

        supabase.table("repair_requests").update(
            {
                "requester_id": req.requester_id,
                "selected_items": req.selected_items,
                "status": req.status,
            }
        ).eq("repair_request_id", req.repair_request_id).execute()
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
            .select("id, role, name, phone_number, company_name")
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
            "intro": None,
        }
        try:
            extra_res = (
                supabase.table("partner_profiles")
                .select("business_location, service_regions, years_experience, employee_count, intro")
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
                    .select("business_location, service_regions, years_experience, employee_count, intro")
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


@app.post("/api/me/profile")
async def update_my_profile(body: MyProfileUpdate):
    try:
        base_update = {}
        if body.role in ["requester", "contractor"]:
            base_update["role"] = body.role
        if body.name is not None:
            base_update["name"] = body.name
        if body.phone_number is not None:
            base_update["phone_number"] = body.phone_number
        if body.company_name is not None:
            base_update["company_name"] = body.company_name
        if base_update:
            supabase.table("profiles").update(base_update).eq("id", body.user_id).execute()

        effective_role = body.role
        if not effective_role:
            profile = _get_profile(body.user_id)
            effective_role = profile.get("role") if profile else None

        if effective_role == "contractor":
            upsert_payload = {
                "partner_id": body.user_id,
                "business_location": body.business_location or "",
                "service_regions": body.service_regions or [],
                "years_experience": body.years_experience,
                "employee_count": body.employee_count,
                "intro": body.intro or "",
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
        return {"status": "success"}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
async def get_market_list(partner_id: str):
    """수리업체용: 지역(시/군/구)+수리항목 중심 마켓 목록(상세주소 비노출)."""
    try:
        _require_active_role(partner_id, ["contractor"], "contractor")
        req_res = (
            supabase.table("repair_requests")
            .select(
                "repair_request_id, status, region_summary, building_name, parking_type, "
                "selected_items, created_at"
            )
            .in_("status", ["requested", "bidding", "matched"])
            .order("created_at", desc=True)
            .execute()
        )
        bid_res = (
            supabase.table("bids")
            .select("repair_request_id")
            .eq("partner_id", partner_id)
            .execute()
        )
        bid_ids = [b["repair_request_id"] for b in bid_res.data]
        market_data = []
        for r in req_res.data:
            r["already_bid"] = r["repair_request_id"] in bid_ids
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
                "selected_items, parsed_data, created_at"
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

        if current_status == "requested":
            (
                supabase.table("repair_requests")
                .update({"status": "bidding"})
                .eq("repair_request_id", bid.repair_request_id)
                .execute()
            )
        if is_first_bid:
            _enqueue_notification(
                "first_bid_submitted",
                bid.partner_id,
                {
                    "repair_request_id": bid.repair_request_id,
                    "bid_id": res.data[0].get("bid_id"),
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
                _enqueue_notification(
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
            .select("id, role, is_active, name, phone_number, company_name, created_at")
            .order("created_at", desc=True)
            .limit(200)
            .execute()
        )
    except Exception:
        users = (
            supabase.table("profiles")
            .select("id, role, name, phone_number, company_name, created_at")
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
