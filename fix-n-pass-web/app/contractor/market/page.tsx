"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function ContractorMarketPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [requests, setRequests] = useState<any[]>([]);
  const [serviceRegions, setServiceRegions] = useState<string[]>([]);
  const [regionFilter, setRegionFilter] = useState<string>("ALL");
  const [requestStatusFilter, setRequestStatusFilter] = useState<string>("ALL");
  const [myStatusFilter, setMyStatusFilter] = useState<string>("ALL");
  const [inactiveNotice, setInactiveNotice] = useState("");

  useEffect(() => {
    const checkAccess = async () => {
      // 1. 현재 세션(로그인 상태) 확인
      const { data: { session } } = await supabase.auth.getSession();
      
      if (!session) {
        alert("로그인이 필요한 서비스입니다.");
        router.replace("/login"); // push 대신 replace를 써서 뒤로가기 꼼수 방지
        return;
      }

      // 2. DB(profiles 테이블)에서 해당 유저의 역할(role) 조회
      const { data: profile, error } = await supabase
        .from("profiles")
        .select("role,is_active")
        .eq("id", session.user.id)
        .single();

      if (error || !profile) {
        alert("프로필 정보를 불러오는데 실패했습니다.");
        router.replace("/onboarding");
        return;
      }

      // 3. 권한 검증 및 튕겨내기 (수리업체가 아니면 메인으로 쫓아냄)
      if (profile.role !== "contractor") {
        alert("수리업체 전용 메뉴입니다. 일반 의뢰인은 접근할 수 없습니다.");
        router.replace("/"); // 의뢰인 홈으로 강제 이동
        return;
      }
      if (profile.is_active === false) {
        setInactiveNotice("관리자 승인 후 관심 지역의 견적 요청을 확인하실 수 있습니다. 조금만 기다려주세요.");
      }

      // 4. 모든 보안 검사 통과 시 화면 렌더링 허용
      setIsAuthorized(true);
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const [marketRes, myRes] = await Promise.all([
        fetch(`${baseUrl}/api/contractor/market?partner_id=${session.user.id}&request_status=${encodeURIComponent(requestStatusFilter)}&my_status_filter=${encodeURIComponent(myStatusFilter)}`),
        fetch(`${baseUrl}/api/me/profile?user_id=${session.user.id}`),
      ]);
      const marketJson = await marketRes.json().catch(() => ({} as any));
      if (!marketRes.ok) {
        if (marketRes.status === 403) {
          setInactiveNotice(marketJson.detail || "관리자 승인 후 관심 지역의 견적 요청을 확인하실 수 있습니다. 조금만 기다려주세요.");
          setRequests([]);
        } else {
          alert(marketJson.detail || "요청 정보를 불러오지 못했습니다.");
        }
      } else {
        setRequests(marketJson.data || []);
      }
      const myJson = await myRes.json();
      const regions = myJson?.data?.partner_profile?.service_regions;
      if (Array.isArray(regions)) setServiceRegions(regions);
      setIsLoading(false);
    };

    checkAccess();
  }, [router, requestStatusFilter, myStatusFilter]);

  // 검사가 진행 중일 때 보여줄 로딩 화면
  if (isLoading) {
    return (
      <div className="flex justify-center items-center h-[60vh]">
        <div className="text-xl font-bold text-gray-500 animate-pulse">
          권한을 확인하는 중입니다...
        </div>
      </div>
    );
  }

  // 권한이 없어서 튕겨내는 찰나의 순간에 보여줄 빈 화면
  if (!isAuthorized) {
    return null; 
  }

  const visibleRequests = requests.filter((req) => {
    if (regionFilter === "ALL") return true;
    return req.region_summary === regionFilter;
  });

  const regionOptions = Array.from(new Set(requests.map((r) => r.region_summary).filter(Boolean)));

  return (
    <div className="max-w-5xl mx-auto mt-10 p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-2">수리 마켓 (업체 전용)</h1>
      <p className="text-gray-600 mb-8 text-sm leading-relaxed">
        제출하신 견적이 선택될 경우 연락처, 주소 등 상세 정보가 공개됩니다.
      </p>
      <div className="mb-5 bg-white border rounded-xl p-4">
        {inactiveNotice && (
          <div className="mb-3 text-sm rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
            {inactiveNotice}
          </div>
        )}
        <p className="text-xs text-slate-500 mb-2">내 관심 지역</p>
        <div className="flex flex-wrap gap-2 mb-3">
          {serviceRegions.length === 0 && <span className="text-sm text-slate-400">미등록</span>}
          {serviceRegions.map((r) => (
            <span key={r} className="px-2 py-1 bg-emerald-50 text-emerald-700 text-xs rounded-full border border-emerald-200">
              {r}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">지역 필터</span>
          <select
            value={regionFilter}
            onChange={(e) => setRegionFilter(e.target.value)}
            className="border rounded-lg px-2 py-1 text-sm"
          >
            <option value="ALL">전체 지역</option>
            {regionOptions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-xs text-slate-500">요청 상태</span>
          <select value={requestStatusFilter} onChange={(e) => setRequestStatusFilter(e.target.value)} className="border rounded-lg px-2 py-1 text-sm">
            <option value="ALL">전체</option>
            <option value="requested">신규요청</option>
            <option value="bidding">견적중</option>
            <option value="matched">업체선정</option>
            <option value="repairing">진행중</option>
            <option value="completed">완료</option>
          </select>
          <span className="text-xs text-slate-500 ml-2">내 상태</span>
          <select value={myStatusFilter} onChange={(e) => setMyStatusFilter(e.target.value)} className="border rounded-lg px-2 py-1 text-sm">
            <option value="ALL">전체</option>
            <option value="미제출">미제출</option>
            <option value="견적 제출완료">견적 제출완료</option>
            <option value="내 견적 선택됨">내 견적 선택됨</option>
            <option value="타업체 선정됨">타업체 선정됨</option>
          </select>
        </div>
      </div>

      <div className="grid gap-4">
        {visibleRequests.length === 0 && (
          <div className="p-8 border rounded-xl text-center bg-white text-gray-500">
            현재 확인 가능한 견적 요청이 없습니다.
          </div>
        )}
        {visibleRequests.map((req) => (
          <Link
            key={req.repair_request_id}
            href={`/contractor/market/${req.repair_request_id}`}
            className="block bg-white rounded-xl border p-5 hover:border-blue-400 transition-colors"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-800">{req.site_alias || "비공개 현장"}</h2>
              <span className={`text-xs px-2 py-1 rounded-full font-semibold ${req.already_bid ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                {req.my_bid_status || (req.already_bid ? "견적 제출함" : "미제출")}
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-3">{req.region_summary}</p>
            <p className="text-xs text-slate-400 mb-1">
              요청 등록일: {req.created_at ? new Date(req.created_at).toLocaleDateString("ko-KR") : "-"}
            </p>
            <p className="text-xs text-slate-500 mb-1">
              견적 마감일:{" "}
              {req.quote_deadline_at
                ? new Date(req.quote_deadline_at).toLocaleDateString("ko-KR")
                : "-"}
              {req.quote_deadline_at && (
                <span className="ml-2 font-bold text-rose-600">
                  {(() => {
                    const d = Math.ceil((new Date(req.quote_deadline_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
                    return d >= 0 ? `D-${d}` : `D+${Math.abs(d)}`;
                  })()}
                </span>
              )}
            </p>
            <p className="text-xs text-slate-500 mb-2">
              내 견적 등록일:{" "}
              {req.my_bid_submitted_at
                ? new Date(req.my_bid_submitted_at).toLocaleDateString("ko-KR")
                : req.already_bid
                  ? "-"
                  : "미제출"}
            </p>
            <div className="text-xs text-indigo-600 mb-2">요청 상태: {req.request_stage_kr || req.status}</div>
            <div className="text-sm text-gray-700">
              요청 항목: <span className="font-semibold">{req.selected_items?.length || 0}개</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}