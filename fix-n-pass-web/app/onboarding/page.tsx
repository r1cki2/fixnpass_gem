"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // 화면 진입 시 현재 로그인된 유저 ID 확인
  useEffect(() => {
    const fetchUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login"); // 세션이 없으면 비정상 접근이므로 로그인창으로 돌려보냄
      } else {
        setUserId(session.user.id);
      }
    };
    fetchUser();
  }, [router]);

  // 역할 선택 시 DB 업데이트 함수
  const handleRoleSelect = async (role: "client" | "contractor") => {
    if (!userId) return;
    setIsLoading(true);

    // public.profiles 테이블의 role 컬럼 업데이트 (UPDATE 쿼리)
    const { error } = await supabase
      .from("profiles")
      .update({ role: role })
      .eq("id", userId);

    if (error) {
      alert("역할 설정 중 오류가 발생했습니다: " + error.message);
      setIsLoading(false);
      return;
    }

    // 데이터 적재 성공 시, 역할에 맞는 맞춤형 메인 화면으로 이동
    if (role === "client") {
      router.push("/"); // 의뢰인은 메인 홈으로
    } else {
      router.push("/contractor/market"); // 수리업체는 업체용 마켓으로
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-20 p-6 text-center">
      <h1 className="text-3xl font-bold text-gray-800 mb-4">환영합니다!</h1>
      <p className="text-lg text-gray-600 mb-12">
        원활한 서비스 이용을 위해 회원님의 역할을 선택해 주세요.
      </p>

      <div className="grid md:grid-cols-2 gap-8">
        {/* 의뢰인 버튼 */}
        <button
          onClick={() => handleRoleSelect("client")}
          disabled={isLoading}
          className="flex flex-col items-center justify-center p-10 bg-white border-2 border-gray-200 rounded-2xl hover:border-blue-500 hover:bg-blue-50 transition-all group disabled:opacity-50"
        >
          <div className="text-5xl mb-4">🏢</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2 group-hover:text-blue-600">
            건물주 / 관리인
          </h2>
          <p className="text-gray-500 break-keep">
            기계식 주차장 검사서류를 분석하고 수리를 의뢰하고 싶습니다.
          </p>
        </button>

        {/* 수리업체 버튼 */}
        <button
          onClick={() => handleRoleSelect("contractor")}
          disabled={isLoading}
          className="flex flex-col items-center justify-center p-10 bg-white border-2 border-gray-200 rounded-2xl hover:border-green-500 hover:bg-green-50 transition-all group disabled:opacity-50"
        >
          <div className="text-5xl mb-4">🔧</div>
          <h2 className="text-2xl font-bold text-gray-800 mb-2 group-hover:text-green-600">
            보수 / 수리 업체
          </h2>
          <p className="text-gray-500 break-keep">
            의뢰인들의 요청을 확인하고 견적을 내어 수리를 진행하고 싶습니다.
          </p>
        </button>
      </div>
    </div>
  );
}