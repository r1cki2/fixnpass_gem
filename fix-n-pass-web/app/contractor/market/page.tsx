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
        .select("role")
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

      // 4. 모든 보안 검사 통과 시 화면 렌더링 허용
      setIsAuthorized(true);
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const [marketRes, myRes] = await Promise.all([
        fetch(`${baseUrl}/api/contractor/market?partner_id=${session.user.id}`),
        fetch(`${baseUrl}/api/me/profile?user_id=${session.user.id}`),
      ]);
      const marketJson = await marketRes.json();
      const myJson = await myRes.json();
      setRequests(marketJson.data || []);
      const regions = myJson?.data?.partner_profile?.service_regions;
      if (Array.isArray(regions)) setServiceRegions(regions);
      setIsLoading(false);
    };

    checkAccess();
  }, [router]);

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
      <p className="text-gray-600 mb-8">상세주소는 비공개이며, 지역(구)과 수리 항목만 표시됩니다.</p>
      <div className="mb-5 bg-white border rounded-xl p-4">
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
            <div className="text-xs text-indigo-600 mb-2">요청 상태: {req.request_stage_kr || req.status}</div>
            <div className="text-sm text-gray-700 mb-2">
              요청 항목: <span className="font-semibold">{req.selected_items?.length || 0}개</span>
            </div>
            <p className="text-xs text-slate-500">
              제출하신 견적이 선택될 경우 연락처, 주소 등 상세 정보가 공개됩니다.
            </p>
          </Link>
        ))}
      </div>
    </div>
  );
}