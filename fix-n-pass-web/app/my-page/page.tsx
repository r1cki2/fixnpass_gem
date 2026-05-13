"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
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

export default function MyPage() {
  const router = useRouter();
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<"requester" | "contractor" | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [officePhone, setOfficePhone] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [requesterAddress, setRequesterAddress] = useState("");
  const [regionsInput, setRegionsInput] = useState("");
  const [serviceRegions, setServiceRegions] = useState<string[]>([]);
  const [years, setYears] = useState("");
  const [employees, setEmployees] = useState("");
  const [loading, setLoading] = useState(true);
  const [withdrawBlocked, setWithdrawBlocked] = useState(false);
  const [withdrawMessage, setWithdrawMessage] = useState("");
  const [withdrawEmail, setWithdrawEmail] = useState("");
  const [withdrawBusy, setWithdrawBusy] = useState(false);

  useEffect(() => {
    const run = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) {
        setLoading(false);
        return;
      }
      setUserId(user.id);
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/me/profile?user_id=${user.id}`);
      const json = await res.json();
      if (res.ok && json.data) {
        const p = json.data.profile || {};
        const pp = json.data.partner_profile || {};
        setRole((p.role || null) as any);
        setName(p.name || "");
        setPhone(p.phone_number || "");
        setOfficePhone(p.office_phone_number || "");
        setCompany(p.company_name || "");
        setLocation(pp.business_location || "");
        setRequesterAddress(user.user_metadata?.requester_address || "");
        const sr = Array.isArray(pp.service_regions) ? pp.service_regions : [];
        const loc = (pp.business_location || "").trim();
        const nextSr =
          sr.length === 0 && loc ? getDefaultInterestRegions(loc) : sr;
        setServiceRegions(nextSr);
        setRegionsInput(nextSr.join(", "));
        setYears(pp.years_experience ? String(pp.years_experience) : "");
        setEmployees(pp.employee_count ? String(pp.employee_count) : "");
      }
      setLoading(false);
    };
    run();
  }, []);

  useEffect(() => {
    const loadWithdraw = async () => {
      if (!userId) return;
      const { data: { session } } = await supabase.auth.getSession();
      const tok = session?.access_token;
      if (!tok) return;
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/me/withdrawal-eligibility`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json.data) {
        setWithdrawBlocked(Boolean(json.data.blocked));
        setWithdrawMessage(json.data.message || "");
      }
    };
    loadWithdraw();
  }, [userId]);

  const save = async () => {
    if (!userId) return alert("로그인이 필요합니다.");
    const nameErr = validateKoreanName(name);
    if (nameErr) return alert(nameErr);
    const mobileErr = validateMobileNumber(phone);
    if (mobileErr) return alert(mobileErr);
    const officeErr = validateOfficePhoneNumber(officePhone);
    if (officeErr) return alert(officeErr);
    if (role === "contractor") {
      const companyErr = validateCompanyName(company);
      if (companyErr) return alert(companyErr);
    }
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const payload: any = {
      user_id: userId,
      name,
      phone_number: normalizeDigits(phone),
      office_phone_number: normalizeDigits(officePhone),
      role,
      company_name: company,
    };
    if (role === "contractor") {
      payload.business_location = location;
      payload.service_regions = regionsInput.split(",").map((s) => s.trim()).filter(Boolean);
      payload.years_experience = years ? Number(years) : null;
      payload.employee_count = employees ? Number(employees) : null;
    }
    const res = await fetch(`${baseUrl}/api/me/profile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "저장 실패");
    if (role === "requester") {
      await supabase.auth.updateUser({
        data: { requester_address: requesterAddress },
      });
    }
    alert("저장되었습니다.");
  };

  const withdrawAccount = async () => {
    if (!userId) return;
    if (withdrawBlocked) {
      alert(withdrawMessage || "현재 탈퇴할 수 없습니다. 고객 문의를 이용해 주세요.");
      return;
    }
    if (
      !confirm(
        "회원 탈퇴 시 프로필 등 개인정보가 삭제되며, 본인과 연결된 견적 요청·견적 제출 내역 등 서비스 데이터도 함께 삭제될 수 있습니다.\n\n정말 탈퇴하시겠습니까?"
      )
    ) {
      return;
    }
    const { data: { session } } = await supabase.auth.getSession();
    const tok = session?.access_token;
    if (!tok) return alert("세션이 만료되었습니다. 다시 로그인해 주세요.");
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    setWithdrawBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/me/withdraw`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tok}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ confirm_email: withdrawEmail.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (res.status === 409) {
        alert(json.detail || withdrawMessage || "관리자 확인이 필요합니다.");
        return;
      }
      if (!res.ok) {
        alert(json.detail || "탈퇴 처리에 실패했습니다.");
        return;
      }
      await supabase.auth.signOut();
      alert("탈퇴가 완료되었습니다.");
      router.replace("/");
    } finally {
      setWithdrawBusy(false);
    }
  };

  if (loading) return <div className="p-10">로딩 중...</div>;
  if (!userId) return <div className="p-10">로그인 후 이용 가능합니다.</div>;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <div className="mb-6 flex items-center gap-3">
        <h1 className="text-2xl font-black">마이페이지</h1>
        <span className="px-2 py-1 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
          역할: {role === "contractor" ? "수리 업체" : "수리 의뢰인(건물주, 관리 대행 등)"}
        </span>
      </div>
      <div className="bg-white border rounded-2xl p-6 space-y-4">
        <Field label="이름" value={name} setValue={setName} />
        <Field label="휴대폰 번호" value={phone} setValue={setPhone} />
        <Field label="사무실 전화번호(선택)" value={officePhone} setValue={setOfficePhone} />
        {role === "requester" && (
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">건물 소재지</label>
            <AddressSearchInput value={requesterAddress} onChange={setRequesterAddress} />
          </div>
        )}
        {role === "contractor" && (
          <>
            <Field label="업체명" value={company} setValue={setCompany} />
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">소재지</label>
              <AddressSearchInput value={location} onChange={setLocation} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">관심 지역</label>
              <InterestRegionPicker
                value={serviceRegions}
                baseAddress={location}
                onChange={(next) => {
                  setServiceRegions(next);
                  setRegionsInput(next.join(", "));
                }}
              />
              <p className="text-xs text-slate-500 mt-2">
                관심지역으로 등록된 곳에서 견적 요청이 있으면 이메일로 안내해드리겠습니다.
              </p>
              <div className="flex flex-wrap gap-2 mt-3">
                {serviceRegions.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => {
                      const next = serviceRegions.filter((x) => x !== r);
                      setServiceRegions(next);
                      setRegionsInput(next.join(", "));
                    }}
                    className="px-2 py-1 text-xs rounded-full border bg-slate-50 text-slate-700"
                  >
                    {r} ×
                  </button>
                ))}
              </div>
            </div>
            <Field label="업력(년)" value={years} setValue={setYears} />
            <Field label="직원수" value={employees} setValue={setEmployees} />
          </>
        )}
        <button onClick={save} className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold">
          저장
        </button>
      </div>

      <div className="mt-8 bg-rose-50 border border-rose-200 rounded-2xl p-6 space-y-4">
        <h2 className="text-lg font-black text-rose-900">회원 탈퇴</h2>
        <p className="text-sm text-rose-900/90 leading-relaxed">
          탈퇴 시 이름·연락처·주소 등 개인정보는 삭제되며, 본인 계정과 연결된 견적 요청·견적 제출 등 이용 기록도 삭제됩니다.
        </p>
        {withdrawBlocked ? (
          <div className="rounded-xl bg-white border border-amber-300 px-4 py-3 text-sm text-amber-950 font-medium leading-relaxed">
            {withdrawMessage ||
              "진행 중인 건으로 인해 바로 탈퇴할 수 없습니다. 고객 문의를 통해 관리자에게 연락해 주세요."}
          </div>
        ) : (
          <>
            <p className="text-xs text-slate-600">
              로그인에 사용 중인 이메일을 아래에 입력한 뒤 탈퇴를 진행해 주세요.
            </p>
            <input
              type="email"
              value={withdrawEmail}
              onChange={(e) => setWithdrawEmail(e.target.value)}
              placeholder="가입 이메일"
              className="w-full border border-rose-200 rounded-lg px-3 py-2 text-sm"
              autoComplete="off"
            />
            <button
              type="button"
              disabled={withdrawBusy}
              onClick={withdrawAccount}
              className="w-full py-3 rounded-lg border-2 border-rose-700 text-rose-800 font-bold text-sm hover:bg-rose-100 disabled:opacity-50"
            >
              {withdrawBusy ? "처리 중…" : "회원 탈퇴 진행"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, value, setValue }: { label: string; value: string; setValue: (v: string) => void }) {
  return (
    <div>
      <label className="block text-sm font-semibold text-slate-700 mb-2">{label}</label>
      <input value={value} onChange={(e) => setValue(e.target.value)} className="w-full border rounded-lg px-3 py-2" />
    </div>
  );
}
