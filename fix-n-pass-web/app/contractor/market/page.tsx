"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export default function ContractorMarketPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(true);
  const [isAuthorized, setIsAuthorized] = useState(false);

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
    <div className="max-w-5xl mx-auto mt-10 p-6 bg-white rounded-xl shadow-sm border border-gray-200">
      <h1 className="text-3xl font-bold text-gray-800 mb-4">수리 마켓 (업체 전용)</h1>
      <p className="text-gray-600 mb-8">
        여기는 수리업체만 들어올 수 있는 보안 공간입니다. 의뢰인들이 올린 수리 요청 목록이 이곳에 표시될 예정입니다.
      </p>
      
      <div className="p-8 border-2 border-dashed border-gray-300 rounded-lg text-center bg-gray-50">
        <span className="text-4xl block mb-4">🚧</span>
        <h2 className="text-xl font-bold text-gray-700">수리 요청 데이터 적재 대기 중</h2>
        <p className="text-gray-500 mt-2">
          (다음 단계에서 의뢰인이 PDF를 파싱하여 데이터를 올리면 여기에 나타납니다.)
        </p>
      </div>
    </div>
  );
}