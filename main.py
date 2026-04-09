import json
import os
import tempfile
import uuid
from datetime import datetime
from typing import List, Optional

import fitz
import httpx
from fastapi import FastAPI, File, HTTPException, UploadFile
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
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

ORIGINAL_BUCKET = "inspection-original"
MASKED_BUCKET = "inspection-masked"

GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
)


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


def _safe_list(v):
    return v if isinstance(v, list) else []


def _build_masked_pdf(ai_data: dict) -> bytes:
    """
    업체 노출용 PDF(민감정보 미포함).
    원본을 전달하지 않고, AI 요약 정보만 재구성한다.
    """
    building_name = ai_data.get("building_name", "건물명 미확인")
    region_summary = ai_data.get("region_summary", "위치 미확인")
    parking_type = ai_data.get("parking_type", "기종 확인 불가")
    mandatory = _safe_list(ai_data.get("mandatory_repairs", []))
    optional = _safe_list(ai_data.get("optional_repairs", []))

    doc = fitz.open()
    page = doc.new_page(width=595, height=842)  # A4
    y = 60

    def write_line(text: str, size: int = 12, indent: int = 50):
        nonlocal y
        page.insert_text((indent, y), text, fontsize=size)
        y += 20 if size <= 12 else 26

    write_line("fix&pass - Contractor View", size=16)
    write_line(f"Building: {building_name}")
    write_line(f"Region (sigungu): {region_summary}")
    write_line(f"Parking Type: {parking_type}")
    y += 10
    write_line("[Mandatory Repairs]", size=14)
    if mandatory:
        for idx, item in enumerate(mandatory, start=1):
            write_line(f"{idx}. {item}", indent=70)
    else:
        write_line("- none", indent=70)
    y += 10
    write_line("[Optional Repairs]", size=14)
    if optional:
        for idx, item in enumerate(optional, start=1):
            write_line(f"{idx}. {item}", indent=70)
    else:
        write_line("- none", indent=70)

    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


@app.post("/api/upload-pdf")
async def upload_pdf(requester_id: Optional[str] = None, file: UploadFile = File(...)):
    req_token = str(uuid.uuid4())
    original_path = f"requester/{requester_id}/{req_token}/original.pdf"
    masked_path = f"request/{req_token}/masked.pdf"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        file_bytes = await file.read()
        tmp.write(file_bytes)
        tmp_path = tmp.name

    try:
        # 1) 원본은 private 버킷에 저장 (public URL 금지)
        supabase.storage.from_(ORIGINAL_BUCKET).upload(path=original_path, file=file_bytes)

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
        masked_bytes = _build_masked_pdf(ai_data)
        supabase.storage.from_(MASKED_BUCKET).upload(path=masked_path, file=masked_bytes)

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
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


@app.post("/api/update-request")
async def update_request(req: UpdateRequest):
    try:
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
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests")
async def get_my_requests(requester_id: str):
    try:
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
            # 선택된 업체만 연락 후 상세자료 접근 가능하게 제한
            selected_ids = req.get("selected_bid_ids", []) or []
            partner_bid = (
                supabase.table("bids")
                .select("bid_id")
                .eq("repair_request_id", request_id)
                .eq("partner_id", user_id)
                .execute()
            )
            if not partner_bid.data:
                raise HTTPException(status_code=403, detail="권한이 없습니다.")
            if partner_bid.data[0]["bid_id"] not in selected_ids:
                raise HTTPException(status_code=403, detail="선택된 업체만 접근할 수 있습니다.")

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
        return {"status": "success", "data": res.data[0]}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/match-partners")
async def match_partners(data: MatchPartners):
    try:
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
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.api_route("/", methods=["GET", "HEAD"])
def health():
    return {"status": "ok"}
