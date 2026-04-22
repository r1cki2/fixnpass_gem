"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";
import AddressSearchInput from "@/components/AddressSearchInput";
import InterestRegionPicker from "@/components/InterestRegionPicker";
import { getDefaultInterestRegions } from "@/lib/regionAdjacency";
import {
  normalizeDigits,
  validateCompanyName,
  validateKoreanName,
  validateMobileNumber,
  validateOfficePhoneNumber,
} from "@/lib/validation";

export default function SignupPage() {
  const router = useRouter();
  const [role, setRole] = useState<"requester" | "contractor" | "">("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [mobile1, setMobile1] = useState("010");
  const [mobile2, setMobile2] = useState("");
  const [mobile3, setMobile3] = useState("");
  const [office1, setOffice1] = useState("");
  const [office2, setOffice2] = useState("");
  const [office3, setOffice3] = useState("");
  const [requesterAddress, setRequesterAddress] = useState("");
  const [requesterAddressDetail, setRequesterAddressDetail] = useState("");
  const [buildingRole, setBuildingRole] = useState<"owner" | "manager" | "">("");
  const [companyName, setCompanyName] = useState("");
  const [region, setRegion] = useState("");
  const [serviceRegions, setServiceRegions] = useState<string[]>([]);
  const [years, setYears] = useState("");
  const [employees, setEmployees] = useState("");
  const [requireApproval, setRequireApproval] = useState(true);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
        const res = await fetch(`${baseUrl}/api/signup-config`);
        const json = await res.json().catch(() => ({}));
        if (res.ok) setRequireApproval(Boolean(json.data?.require_contractor_approval));
      } catch {
        setRequireApproval(true);
      }
    })();
  }, []);

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!role) {
      setMessage("역할을 먼저 선택해주세요.");
      return;
    }
    if (password !== passwordConfirm) {
      setMessage("비밀번호 확인이 일치하지 않습니다.");
      return;
    }

    setIsLoading(true);
    setMessage("");
    const phoneNumber = `${mobile1}-${mobile2}-${mobile3}`;
    const officePhoneNumber = [office1, office2, office3].filter(Boolean).join("-");
    const mobileErr = validateMobileNumber(phoneNumber);
    if (mobileErr) {
      setMessage(mobileErr);
      setIsLoading(false);
      return;
    }
    const nameErr = validateKoreanName(name);
    if (nameErr) {
      setMessage(nameErr);
      setIsLoading(false);
      return;
    }
    const officeErr = validateOfficePhoneNumber(officePhoneNumber);
    if (officeErr) {
      setMessage(officeErr);
      setIsLoading(false);
      return;
    }
    if (role === "requester" && !requesterAddress.trim()) {
      setMessage("수리 의뢰인용 건물 소재지를 입력해주세요.");
      setIsLoading(false);
      return;
    }
    if (role === "requester" && !buildingRole) {
      setMessage("수리 의뢰인 구분(건물주/관리 대행)을 선택해주세요.");
      setIsLoading(false);
      return;
    }
    if (role === "contractor" && (!companyName.trim() || !region.trim())) {
      setMessage("수리 업체는 상호와 소재지를 필수로 입력해주세요.");
      setIsLoading(false);
      return;
    }
    if (role === "contractor") {
      const companyErr = validateCompanyName(companyName);
      if (companyErr) {
        setMessage(companyErr);
        setIsLoading(false);
        return;
      }
    }
    if (role === "contractor" && serviceRegions.length === 0) {
      setMessage("수리 가능 관심 지역을 1곳 이상 선택해주세요.");
      setIsLoading(false);
      return;
    }
    const cleanPhone = normalizeDigits(phoneNumber);
    const cleanOfficePhone = normalizeDigits(officePhoneNumber);

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          role,
          name,
          phone_number: cleanPhone,
          office_phone_number: cleanOfficePhone || null,
          building_role: role === "requester" ? buildingRole : null,
          requester_address: role === "requester" ? requesterAddress.trim() : null,
          requester_address_detail: role === "requester" ? requesterAddressDetail.trim() : null,
          company_name: role === "contractor" ? companyName.trim() : null,
          region: role === "contractor" ? region.trim() : null,
          verification_status: "pending",
        },
      },
    });

    if (error) {
      setMessage("회원가입 실패: " + error.message);
      setIsLoading(false);
      return;
    }

    const { data: userData } = await supabase.auth.getUser();
    const uid = userData.user?.id;
    if (!uid) {
      setMessage("회원가입은 완료되었지만 세션을 확인하지 못했습니다. 로그인 후 마이페이지에서 정보를 입력해주세요.");
      setIsLoading(false);
      return;
    }

    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const profileRes = await fetch(`${baseUrl}/api/me/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: uid,
        role,
        name: name.trim(),
        phone_number: cleanPhone,
        office_phone_number: cleanOfficePhone || null,
        company_name: role === "contractor" ? companyName.trim() : null,
        business_location: role === "contractor" ? region.trim() : null,
        service_regions: role === "contractor" ? serviceRegions : [],
        years_experience: role === "contractor" && years ? Number(years) : null,
        employee_count: role === "contractor" && employees ? Number(employees) : null,
        trigger_signup_notice: role === "contractor",
      }),
    });
    const profileJson = await profileRes.json().catch(() => ({}));
    if (!profileRes.ok) {
      setMessage(profileJson.detail || "회원 기본 정보 저장에 실패했습니다.");
      setIsLoading(false);
      return;
    }

    if (role === "requester") {
      await supabase.auth.updateUser({
        data: {
          requester_address: requesterAddress.trim(),
          requester_address_detail: requesterAddressDetail.trim(),
          building_role: buildingRole,
        },
      });
    }

    if (role === "contractor" && profileJson?.data?.approval_required) {
      setMessage(
        "수리 업체 가입 신청이 접수되었습니다. 관리자 승인 후 로그인하여 이용할 수 있습니다.",
      );
      setIsLoading(false);
      setTimeout(() => router.push("/login"), 900);
      return;
    }

    setMessage("회원가입이 완료되었습니다. 로그인 후 바로 이용하실 수 있습니다.");
    setIsLoading(false);
    setTimeout(() => router.push(role === "contractor" ? "/contractor/market" : "/"), 800);
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-6 bg-white rounded-xl shadow-md border border-gray-200">
      <h1 className="text-3xl font-bold text-center text-gray-800 mb-2">회원가입</h1>
      <p className="text-center text-sm text-gray-500 mb-8">
        역할을 먼저 선택하고, 역할에 맞는 정보를 입력해 가입을 완료하세요.
      </p>

      <form onSubmit={handleSignUp} className="flex flex-col gap-5">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">가입 역할</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setRole("requester")}
              className={`border rounded-lg p-3 text-sm font-semibold ${role === "requester" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300"}`}
            >
              수리 의뢰인(건물주, 관리 대행 등)
            </button>
            <button
              type="button"
              onClick={() => setRole("contractor")}
              className={`border rounded-lg p-3 text-sm font-semibold ${role === "contractor" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-gray-300"}`}
            >
              수리 업체
            </button>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">이름</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="홍길동"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">휴대폰 번호</label>
          <div className="grid grid-cols-[80px_1fr_1fr] gap-2 items-center">
            <input value={mobile1} onChange={(e) => setMobile1(normalizeDigits(e.target.value).slice(0, 3))} className="px-3 py-3 border border-gray-300 rounded-lg" />
            <input value={mobile2} onChange={(e) => setMobile2(normalizeDigits(e.target.value).slice(0, 4))} className="px-3 py-3 border border-gray-300 rounded-lg" />
            <input value={mobile3} onChange={(e) => setMobile3(normalizeDigits(e.target.value).slice(0, 4))} className="px-3 py-3 border border-gray-300 rounded-lg" />
          </div>
          <p className="text-xs text-gray-500 mt-1">010으로 시작하는 11자리 번호만 입력됩니다.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">사무실 전화번호 (선택)</label>
          <div className="grid grid-cols-3 gap-2">
            <input value={office1} onChange={(e) => setOffice1(normalizeDigits(e.target.value).slice(0, 4))} className="px-3 py-3 border border-gray-300 rounded-lg" placeholder="02" />
            <input value={office2} onChange={(e) => setOffice2(normalizeDigits(e.target.value).slice(0, 4))} className="px-3 py-3 border border-gray-300 rounded-lg" placeholder="1234" />
            <input value={office3} onChange={(e) => setOffice3(normalizeDigits(e.target.value).slice(0, 4))} className="px-3 py-3 border border-gray-300 rounded-lg" placeholder="5678" />
          </div>
        </div>

        {role === "requester" && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                수리 의뢰인 구분
              </label>
              <select
                value={buildingRole}
                onChange={(e) => setBuildingRole(e.target.value as "owner" | "manager" | "")}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                required
              >
                <option value="">선택하세요</option>
                <option value="owner">건물주</option>
                <option value="manager">관리 대행/관리인</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">건물 소재지</label>
              <AddressSearchInput value={requesterAddress} onChange={setRequesterAddress} />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">상세주소 (선택)</label>
              <input
                value={requesterAddressDetail}
                onChange={(e) => setRequesterAddressDetail(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                placeholder="동/호수 등"
              />
            </div>
          </>
        )}

        {role === "contractor" && (
          <>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                상호 <span className="text-rose-600">(필수)</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                placeholder="예: OO엔지니어링"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                소재지 <span className="text-rose-600">(필수)</span>
              </label>
              <AddressSearchInput
                value={region}
                onChange={(v) => {
                  setRegion(v);
                  setServiceRegions((prev) => (prev.length ? prev : getDefaultInterestRegions(v)));
                }}
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                관심 지역(수리 가능 범위)
              </label>
              <InterestRegionPicker value={serviceRegions} baseAddress={region} onChange={setServiceRegions} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">업력(년) (선택)</label>
                <input
                  type="number"
                  min={0}
                  value={years}
                  onChange={(e) => setYears(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">직원수 (선택)</label>
                <input
                  type="number"
                  min={0}
                  value={employees}
                  onChange={(e) => setEmployees(e.target.value)}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg"
                />
              </div>
            </div>
            <p className="text-xs text-slate-500">
              업력/직원수는 선택 입력이며, 입력 시 의뢰인이 업체 선택 전에 참고 정보로 확인할 수 있습니다.
            </p>
            {requireApproval && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-800">
                현재 설정상 수리 업체는 관리자 승인 후 가입이 완료됩니다. 정확한 정보로 입력해 주세요.
              </div>
            )}
          </>
        )}

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">이메일 (로그인 아이디)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="you@example.com"
            required
          />
          <p className="text-xs text-gray-500 mt-1">
            로그인 시에는 이메일 주소가 아이디로 사용됩니다.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="6자리 이상"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">비밀번호 확인</label>
          <input
            type="password"
            value={passwordConfirm}
            onChange={(e) => setPasswordConfirm(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="비밀번호 다시 입력"
            required
          />
        </div>

        <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm text-amber-700">
          베타 버전에서는 형식 검증 후 즉시 사용 가능하며, 본인/허가받은 이해관계인 외 업무 처리에 따른 책임은 당사에 귀속되지 않습니다.
        </div>

        {message && <div className="text-center font-semibold text-blue-600">{message}</div>}

        <button
          type="submit"
          disabled={isLoading}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-lg text-lg transition-colors disabled:bg-gray-400"
        >
          {isLoading ? "처리 중..." : "회원가입"}
        </button>

        <Link href="/login" className="text-center text-sm font-semibold text-blue-600 hover:underline">
          이미 계정이 있나요? 로그인
        </Link>
      </form>
    </div>
  );
}
