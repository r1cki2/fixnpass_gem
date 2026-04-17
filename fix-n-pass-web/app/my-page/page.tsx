"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

export default function MyPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [role, setRole] = useState<"requester" | "contractor" | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [company, setCompany] = useState("");
  const [location, setLocation] = useState("");
  const [requesterAddress, setRequesterAddress] = useState("");
  const [regionsInput, setRegionsInput] = useState("");
  const [years, setYears] = useState("");
  const [employees, setEmployees] = useState("");
  const [intro, setIntro] = useState("");
  const [loading, setLoading] = useState(true);

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
        setCompany(p.company_name || "");
        setLocation(pp.business_location || "");
        setRequesterAddress(user.user_metadata?.requester_address || "");
        setRegionsInput(Array.isArray(pp.service_regions) ? pp.service_regions.join(", ") : "");
        setYears(pp.years_experience ? String(pp.years_experience) : "");
        setEmployees(pp.employee_count ? String(pp.employee_count) : "");
        setIntro(pp.intro || "");
      }
      setLoading(false);
    };
    run();
  }, []);

  const save = async () => {
    if (!userId) return alert("로그인이 필요합니다.");
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const payload: any = {
      user_id: userId,
      name,
      phone_number: phone,
      role,
      company_name: company,
    };
    if (role === "contractor") {
      payload.business_location = location;
      payload.service_regions = regionsInput.split(",").map((s) => s.trim()).filter(Boolean);
      payload.years_experience = years ? Number(years) : null;
      payload.employee_count = employees ? Number(employees) : null;
      payload.intro = intro;
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

  if (loading) return <div className="p-10">로딩 중...</div>;
  if (!userId) return <div className="p-10">로그인 후 이용 가능합니다.</div>;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-2xl font-black mb-6">마이페이지</h1>
      <div className="bg-white border rounded-2xl p-6 space-y-4">
        <Field label="이름" value={name} setValue={setName} />
        <Field label="전화번호" value={phone} setValue={setPhone} />
        {role === "requester" && (
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">건물 소재지</label>
            <div className="flex gap-2">
              <input
                value={requesterAddress}
                onChange={(e) => setRequesterAddress(e.target.value)}
                className="w-full border rounded-lg px-3 py-2"
                placeholder="주소검색으로 입력"
              />
              <button
                type="button"
                onClick={() => {
                  const manual = window.prompt("건물 소재지를 입력하세요", requesterAddress || "");
                  if (manual !== null) setRequesterAddress(manual.trim());
                }}
                className="px-3 py-2 border rounded-lg text-sm"
              >
                주소검색
              </button>
            </div>
          </div>
        )}
        {role === "contractor" && (
          <>
            <Field label="업체명" value={company} setValue={setCompany} />
            <Field label="소재지" value={location} setValue={setLocation} />
            <Field label="관심 지역(쉼표 구분)" value={regionsInput} setValue={setRegionsInput} />
            <Field label="업력(년)" value={years} setValue={setYears} />
            <Field label="직원수" value={employees} setValue={setEmployees} />
            <div>
              <label className="block text-sm font-semibold text-slate-700 mb-2">업체 소개</label>
              <textarea
                value={intro}
                onChange={(e) => setIntro(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 min-h-28"
              />
            </div>
          </>
        )}
        <button onClick={save} className="w-full bg-slate-900 text-white py-3 rounded-lg font-bold">
          저장
        </button>
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
