"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export default function OnboardingPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<"requester" | "contractor" | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [region, setRegion] = useState("");
  const [serviceRegionsInput, setServiceRegionsInput] = useState("");
  const [buildingRole, setBuildingRole] = useState<"owner" | "manager" | "">("");

  // 화면 진입 시 현재 로그인된 유저 ID 확인
  useEffect(() => {
    const fetchUser = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        router.push("/login"); // 세션이 없으면 비정상 접근이므로 로그인창으로 돌려보냄
      } else {
        setUserId(session.user.id);
        const md = session.user.user_metadata || {};
        setPhoneNumber(md.phone_number || "");
        setCompanyName(md.company_name || "");
        setRegion(md.region || "");
      }
    };
    fetchUser();
  }, [router]);

  const handleSubmit = async () => {
    if (!userId || !role) return;
    if (!phoneNumber.trim()) {
      alert("전화번호는 필수입니다.");
      return;
    }
    if (role === "requester" && !buildingRole) {
      alert("건물주/관리인 구분을 선택해주세요.");
      return;
    }
    if (role === "contractor" && (!companyName.trim() || !region.trim())) {
      alert("업체명과 활동 지역은 필수입니다.");
      return;
    }
    if (role === "contractor" && !serviceRegionsInput.trim()) {
      alert("관심 지역은 필수입니다. (쉼표로 구분)");
      return;
    }
    setIsLoading(true);

    const profilePayload: any = {
      role,
      phone_number: phoneNumber.replace(/[^0-9]/g, ""),
    };
    if (role === "contractor") {
      profilePayload.company_name = companyName.trim();
    }

    const { error } = await supabase
      .from("profiles")
      .update(profilePayload)
      .eq("id", userId);

    if (error) {
      alert("역할 설정 중 오류가 발생했습니다: " + error.message);
      setIsLoading(false);
      return;
    }

    const { error: mdError } = await supabase.auth.updateUser({
      data: {
        building_role: role === "requester" ? buildingRole : null,
        region: role === "contractor" ? region.trim() : null,
        company_name: role === "contractor" ? companyName.trim() : null,
        verification_status: "soft-verified-beta",
      },
    });
    if (mdError) {
      alert("추가 정보 저장 중 오류가 발생했습니다: " + mdError.message);
      setIsLoading(false);
      return;
    }

    if (role === "contractor") {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const serviceRegions = serviceRegionsInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const profileRes = await fetch(`${baseUrl}/api/me/profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          role: "contractor",
          company_name: companyName.trim(),
          phone_number: phoneNumber.replace(/[^0-9]/g, ""),
          business_location: region.trim(),
          service_regions: serviceRegions,
        }),
      });
      if (!profileRes.ok) {
        const err = await profileRes.json().catch(() => ({}));
        alert(err.detail || "업체 프로필 저장에 실패했습니다.");
        setIsLoading(false);
        return;
      }
    }

    if (role === "requester") {
      router.push("/");
    } else {
      router.push("/contractor/market");
    }
  };

  return (
    <div className="max-w-3xl mx-auto mt-20 p-6">
      <h1 className="text-3xl font-bold text-gray-800 mb-4">환영합니다!</h1>
      <p className="text-lg text-gray-600 mb-8">
        역할과 기본 정보를 입력하면 온보딩이 완료됩니다.
      </p>

      <div className="grid md:grid-cols-2 gap-8 mb-8">
        {/* 의뢰인 버튼 */}
        <button
          onClick={() => setRole("requester")}
          disabled={isLoading}
          className={`flex flex-col items-center justify-center p-10 bg-white border-2 rounded-2xl transition-all group disabled:opacity-50 ${
            role === "requester" ? "border-blue-500 bg-blue-50" : "border-gray-200 hover:border-blue-500 hover:bg-blue-50"
          }`}
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
          onClick={() => setRole("contractor")}
          disabled={isLoading}
          className={`flex flex-col items-center justify-center p-10 bg-white border-2 rounded-2xl transition-all group disabled:opacity-50 ${
            role === "contractor" ? "border-green-500 bg-green-50" : "border-gray-200 hover:border-green-500 hover:bg-green-50"
          }`}
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

      <div className="bg-white border border-gray-200 rounded-2xl p-6 space-y-4">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">전화번호</label>
          <input
            type="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(e.target.value)}
            placeholder="010-1234-5678"
            className="w-full px-4 py-3 border rounded-lg"
          />
        </div>

        {role === "requester" && (
          <div>
            <label className="block text-sm font-semibold text-gray-700 mb-2">건물주/관리인 구분</label>
            <select
              value={buildingRole}
              onChange={(e) => setBuildingRole(e.target.value as "owner" | "manager" | "")}
              className="w-full px-4 py-3 border rounded-lg bg-white"
            >
              <option value="">선택해주세요</option>
              <option value="owner">건물주</option>
              <option value="manager">관리인</option>
            </select>
          </div>
        )}

        {role === "contractor" && (
          <>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">업체명</label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg"
                placeholder="예: OO기계식주차 보수"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">활동 지역</label>
              <input
                type="text"
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg"
                placeholder="예: 서울 송파구"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">관심 지역(수리 가능 범위)</label>
              <input
                type="text"
                value={serviceRegionsInput}
                onChange={(e) => setServiceRegionsInput(e.target.value)}
                className="w-full px-4 py-3 border rounded-lg"
                placeholder="예: 서울 송파구, 서울 강동구"
              />
            </div>
          </>
        )}

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
          베타 버전에서는 형식 검증 후 즉시 사용 가능하며, 정식 버전에서는 본인/사업자 인증 전 핵심 기능이 제한됩니다.
        </div>

        <button
          onClick={handleSubmit}
          disabled={isLoading || !role}
          className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold disabled:bg-gray-300"
        >
          {isLoading ? "저장 중..." : "온보딩 완료"}
        </button>
      </div>
    </div>
  );
}