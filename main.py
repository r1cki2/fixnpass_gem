import os
import json
import tempfile
import fitz
import httpx
import uuid
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from supabase import create_client, Client
from pydantic import BaseModel
from typing import List, Optional
from datetime import datetime

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 환경 변수 로드
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# [수정] 유저님 지침에 따라 gemini-2.5-flash 모델로 고정
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"


# --- 데이터 모델 ---
class UpdateRequest(BaseModel):
    pdf_url: str
    selected_items: list
    status: str = "requested"


class BidSubmission(BaseModel):
    repair_request_id: int
    partner_id: str
    bid_amount: int


class MatchPartners(BaseModel):
    repair_request_id: int
    selected_bid_ids: List[int]


# --- API 엔드포인트 ---

@app.post("/api/upload-pdf")
async def upload_pdf(requester_id: str, file: UploadFile = File(...)):
    """PDF 업로드 및 유저 지정 프롬프트 기반 AI 분석"""
    storage_path = f"{requester_id}/{uuid.uuid4()}.pdf"
    with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
        file_bytes = await file.read()
        tmp.write(file_bytes)
        tmp_path = tmp.name
    try:
        # 1. Supabase Storage 업로드
        supabase.storage.from_('inspection-pdfs').upload(path=storage_path, file=file_bytes)
        file_url = supabase.storage.from_('inspection-pdfs').get_public_url(storage_path)

        # 2. PDF 텍스트 추출
        doc = fitz.open(tmp_path)
        text = "".join([doc.load_page(i).get_text() for i in range(min(5, len(doc)))])
        doc.close()

        # 3. [유저 지정] 고정 프롬프트 적용
        prompt = f"""
기계식 주차장 안전검사서에서 다음 정보를 추출해 순수 JSON으로만 응답하세요. 마크다운 기호(```)는 금지합니다.

1. building_name: 건물 이름
2. region_summary: 주소에서 '시/군/구'까지만 (예: 서울시 송파구)
3. address_detail: region_summary를 제외한 나머지 상세 주소 전체
4. parking_type: 기계식 주차장의 기종 및 구동 방식(종류 및 방식) (예: 승강기식 횡식 하부승입식. 없으면 '기종 확인 불가')
5. mandatory_repairs: '부적합' 항목 리스트 (운영을 위해 반드시 수리해야 하는 필수 항목이며, 요약해서 표현)
6. optional_repairs: '권고' 또는 '주의' 항목 리스트 (운영은 가능하나 향후 수리가 권장되는 항목이며, 요약해서 표현)

텍스트: {text[:20000]}
"""
        async with httpx.AsyncClient(timeout=60.0) as client:
            ai_res = await client.post(GEMINI_URL, json={"contents": [{"parts": [{"text": prompt}]}]})
            res_json = ai_res.json()

            # API 응답 검증 로직
            if 'candidates' not in res_json:
                error_msg = res_json.get('error', {}).get('message', 'AI 모델 응답 생성 실패')
                raise HTTPException(status_code=500, detail=f"AI 분석 실패: {error_msg}")

            ai_raw = res_json['candidates'][0]['content']['parts'][0]['text']
            if "```" in ai_raw:
                ai_raw = ai_raw.split("```")[1].replace("json", "").strip().split("```")[0].strip()
            ai_data = json.loads(ai_raw)

        # 4. DB 저장
        insert_data = {
            "requester_id": requester_id,
            "status": "pending",
            "region_summary": ai_data.get("region_summary", "위치 미확인"),
            "address_detail": ai_data.get("address_detail", ""),
            "building_name": ai_data.get("building_name", "건물명 미확인"),
            "parking_type": ai_data.get("parking_type", "기종 확인 불가"),
            "pdf_url": file_url,
            "parsed_data": {
                "mandatory": ai_data.get("mandatory_repairs", []),
                "optional": ai_data.get("optional_repairs", [])
            }
        }
        db_res = supabase.table("repair_requests").insert(insert_data).execute()
        return {"status": "success", "data": db_res.data[0]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if os.path.exists(tmp_path): os.remove(tmp_path)


@app.post("/api/update-request")
async def update_request(req: UpdateRequest):
    try:
        supabase.table("repair_requests").update({
            "selected_items": req.selected_items,
            "status": req.status
        }).eq("pdf_url", req.pdf_url).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests")
async def get_my_requests():
    try:
        res = supabase.table("repair_requests").select("*").order("created_at", desc=True).execute()
        return {"status": "success", "data": res.data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests/{request_id}")
async def get_request_detail(request_id: int):
    try:
        res = supabase.table("repair_requests").select("*").eq("repair_request_id", request_id).execute()
        if not res.data: raise HTTPException(status_code=404, detail="Not found")

        partner_id = "1e11b504-4069-4daa-8fc0-5f99ea952906"
        bid_res = supabase.table("bids").select("*").eq("repair_request_id", request_id).eq("partner_id",
                                                                                            partner_id).execute()

        data = res.data[0]
        data['my_bid'] = bid_res.data[0] if bid_res.data else None
        return {"status": "success", "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/my-requests/{request_id}/bids")
async def get_bids_for_request(request_id: int):
    """의뢰인용: 견적 리스트 조회 (평점 및 연락처 마스킹)"""
    try:
        bids_res = supabase.table("bids").select("*, users(name, phone_number)").eq("repair_request_id",
                                                                                    request_id).execute()
        ratings_res = supabase.table("partner_ratings").select("*").execute()
        ratings_dict = {r['partner_id']: r for r in ratings_res.data}

        req_res = supabase.table("repair_requests").select("selected_bid_ids, status").eq("repair_request_id",
                                                                                          request_id).execute()
        selected_ids = req_res.data[0].get('selected_bid_ids', []) or []

        processed_bids = []
        for b in bids_res.data:
            p_id = b['partner_id']
            rating_info = ratings_dict.get(p_id, {"avg_rating": 0, "review_count": 0})
            is_selected = b['bid_id'] in selected_ids
            display_phone = b['users']['phone_number'] if is_selected else "010-****-****"

            processed_bids.append({
                "bid_id": b['bid_id'],
                "partner_id": p_id,
                "partner_name": b['users']['name'],
                "partner_phone": display_phone,
                "bid_amount": b['bid_amount'],
                "avg_rating": float(rating_info['avg_rating']),
                "review_count": int(rating_info['review_count']),
                "is_selected": is_selected
            })
        return {"status": "success", "data": processed_bids}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/contractor/market")
async def get_market_list():
    try:
        req_res = supabase.table("repair_requests").select("*").in_("status",
                                                                    ["requested", "bidding", "matched"]).order(
            "created_at", desc=True).execute()
        partner_id = "1e11b504-4069-4daa-8fc0-5f99ea952906"
        bid_res = supabase.table("bids").select("repair_request_id").eq("partner_id", partner_id).execute()
        bid_ids = [b['repair_request_id'] for b in bid_res.data]

        market_data = []
        for r in req_res.data:
            r['already_bid'] = r['repair_request_id'] in bid_ids
            market_data.append(r)
        return {"status": "success", "data": market_data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/contractor/bid")
async def submit_bid(bid: BidSubmission):
    """수리업체: 견적 제출 및 1회 수정(original_bid_amount 백업) 로직"""
    try:
        req_res = supabase.table("repair_requests").select("status").eq("repair_request_id",
                                                                        bid.repair_request_id).execute()
        if not req_res.data: raise HTTPException(status_code=404, detail="Not found")

        current_status = req_res.data[0]['status']
        if current_status in ['matched', 'repairing', 'completed']:
            raise HTTPException(status_code=400, detail="이미 매칭된 건은 수정 불가")

        existing_bid = supabase.table("bids").select("*").eq("repair_request_id", bid.repair_request_id).eq(
            "partner_id", bid.partner_id).execute()

        if existing_bid.data:
            current_bid = existing_bid.data[0]
            if current_bid.get('edit_count', 0) >= 1:
                raise HTTPException(status_code=400, detail="견적 수정은 1회만 가능")

            res = supabase.table("bids").update({
                "original_bid_amount": current_bid['bid_amount'],
                "bid_amount": bid.bid_amount,
                "edit_count": current_bid.get('edit_count', 0) + 1,
                "updated_at": datetime.utcnow().isoformat()
            }).eq("bid_id", current_bid['bid_id']).execute()
        else:
            res = supabase.table("bids").insert({
                "repair_request_id": bid.repair_request_id,
                "partner_id": bid.partner_id,
                "bid_amount": bid.bid_amount,
                "edit_count": 0
            }).execute()

        if current_status == 'requested':
            supabase.table("repair_requests").update({"status": "bidding"}).eq("repair_request_id",
                                                                               bid.repair_request_id).execute()
        return {"status": "success", "data": res.data[0]}
    except HTTPException as e:
        raise e
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/match-partners")
async def match_partners(data: MatchPartners):
    """의뢰인: 업체 선택 (최대 2개 제한)"""
    try:
        if len(data.selected_bid_ids) > 2:
            raise HTTPException(status_code=400, detail="최대 2개 업체만 가능")
        supabase.table("repair_requests").update({
            "selected_bid_ids": data.selected_bid_ids,
            "status": "matched" if data.selected_bid_ids else "bidding"
        }).eq("repair_request_id", data.repair_request_id).execute()
        return {"status": "success"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.api_route("/", methods=["GET", "HEAD"])
def health(): return {"status": "ok"}