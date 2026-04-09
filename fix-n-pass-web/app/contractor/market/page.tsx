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
      const res = await fetch(`${baseUrl}/api/contractor/market?partner_id=${session.user.id}`);
      const json = await res.json();
      setRequests(json.data || []);
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

  // 완벽하게 권한이 확인된 수리업체에게만 보여줄 실제 화면
  return (
    <div className="max-w-5xl mx-auto mt-10 p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-2">수리 마켓 (업체 전용)</h1>
      <p className="text-gray-600 mb-8">상세주소는 비공개이며, 지역(구)과 수리 항목만 표시됩니다.</p>

      <div className="grid gap-4">
        {requests.length === 0 && (
          <div className="p-8 border rounded-xl text-center bg-white text-gray-500">
            현재 확인 가능한 견적 요청이 없습니다.
          </div>
        )}
        {requests.map((req) => (
          <Link
            key={req.repair_request_id}
            href={`/contractor/market/${req.repair_request_id}`}
            className="block bg-white rounded-xl border p-5 hover:border-blue-400 transition-colors"
          >
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-bold text-gray-800">{req.building_name || "건물명 미확인"}</h2>
              <span className={`text-xs px-2 py-1 rounded-full font-semibold ${req.already_bid ? "bg-emerald-100 text-emerald-700" : "bg-gray-100 text-gray-600"}`}>
                {req.already_bid ? "견적 제출함" : "미제출"}
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-3">{req.region_summary}</p>
            <div className="text-sm text-gray-700">
              요청 항목: <span className="font-semibold">{req.selected_items?.length || 0}개</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}