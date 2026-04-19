"use client";

import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

type AdminOverview = {
  admin_email: string;
  counts: { requests: number; bids: number; profiles: number };
  recent_requests: any[];
};

type Trends = {
  daily: { label: string; total: number; matched: number; completed: number }[];
  weekly: { label: string; total: number; matched: number; completed: number }[];
  monthly: { label: string; total: number; matched: number; completed: number }[];
};

export default function AdminPage() {
  const router = useRouter();
  const [token, setToken] = useState<string>("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [users, setUsers] = useState<any[]>([]);
  const [trends, setTrends] = useState<Trends>({ daily: [], weekly: [], monthly: [] });
  const [loading, setLoading] = useState(true);
  const [popTitle, setPopTitle] = useState("");
  const [popMessage, setPopMessage] = useState("");
  const [popAnnouncements, setPopAnnouncements] = useState<any[]>([]);

  const baseUrl = useMemo(() => process.env.NEXT_PUBLIC_API_BASE_URL, []);

  const authHeader = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

  const fetchAll = async (t: string) => {
    const [oRes, uRes] = await Promise.all([
      fetch(`${baseUrl}/api/admin/overview`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/users`, { headers: authHeader(t) }),
    ]);
    const tRes = await fetch(`${baseUrl}/api/admin/stats/trends`, { headers: authHeader(t) });
    const pRes = await fetch(`${baseUrl}/api/admin/site-announcements`, { headers: authHeader(t) });
    if (oRes.status === 401 || oRes.status === 403) {
      alert("관리자 권한이 없습니다.");
      router.replace("/");
      return;
    }
    const oJson = await oRes.json();
    const uJson = await uRes.json();
    const tJson = await tRes.json();
    if (pRes.ok) {
      const pJson = await pRes.json();
      setPopAnnouncements(pJson.data || []);
    }
    setOverview(oJson.data);
    setUsers(uJson.data || []);
    setTrends(tJson.data || { daily: [], weekly: [], monthly: [] });
  };

  useEffect(() => {
    const init = async () => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) {
        router.replace("/login");
        return;
      }
      setToken(accessToken);
      await fetchAll(accessToken);
      setLoading(false);
    };
    init();
  }, [router, baseUrl]);

  const updateUserRole = async (userId: string, role: "requester" | "contractor") => {
    const res = await fetch(`${baseUrl}/api/admin/users/${userId}/role`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({ role }),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "역할 변경 실패");
    await fetchAll(token);
  };

  const updateRequestStatus = async (requestId: number, status: string) => {
    const res = await fetch(`${baseUrl}/api/admin/requests/${requestId}/status`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({ status }),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "상태 변경 실패");
    await fetchAll(token);
  };

  const updateUserActive = async (userId: string, isActive: boolean) => {
    const res = await fetch(`${baseUrl}/api/admin/users/${userId}/active`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({ is_active: isActive }),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "계정 상태 변경 실패");
    await fetchAll(token);
  };

  const deploySitePopup = async () => {
    const res = await fetch(`${baseUrl}/api/admin/site-announcements/deploy`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({ title: popTitle.trim() || undefined, message: popMessage }),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "배포 실패");
    setPopMessage("");
    setPopTitle("");
    await fetchAll(token);
    alert("첫 화면 팝업이 배포되었습니다.");
  };

  const deactivateAnnouncement = async (id: number) => {
    const res = await fetch(`${baseUrl}/api/admin/site-announcements/${id}/deactivate`, {
      method: "POST",
      headers: authHeader(token),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "비활성화 실패");
    await fetchAll(token);
  };

  if (loading) return <div className="p-10">관리자 데이터를 불러오는 중...</div>;
  if (!overview) return <div className="p-10">데이터를 불러오지 못했습니다.</div>;

  return (
    <div className="max-w-6xl mx-auto py-8 space-y-8">
      <div>
        <h1 className="text-3xl font-black text-slate-900">관리자 대시보드</h1>
        <p className="text-sm text-slate-500 mt-1">관리자 계정: {overview.admin_email}</p>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Card title="총 요청" value={overview.counts.requests} />
        <Card title="총 견적" value={overview.counts.bids} />
        <Card title="총 사용자 프로필" value={overview.counts.profiles} />
      </div>

      <section className="bg-white border rounded-2xl p-5 space-y-4">
        <h2 className="text-xl font-bold">첫 화면 팝업 (알림 배포)</h2>
        <p className="text-sm text-slate-500">
          배포 시 기존에 켜져 있던 팝업은 자동으로 끄고, 새 문구만 방문자 첫 화면에 표시됩니다. 사용자가 닫으면 해당 팝업 ID는 브라우저에 저장되어 다시 뜨지 않습니다.
        </p>
        <input
          value={popTitle}
          onChange={(e) => setPopTitle(e.target.value)}
          placeholder="제목 (선택)"
          className="w-full border rounded-lg px-3 py-2 text-sm"
        />
        <textarea
          value={popMessage}
          onChange={(e) => setPopMessage(e.target.value)}
          placeholder="팝업 본문"
          className="w-full border rounded-lg px-3 py-2 text-sm min-h-[100px]"
        />
        <button
          type="button"
          onClick={() => deploySitePopup()}
          className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold text-sm hover:bg-indigo-700"
        >
          배포하기
        </button>
        <div className="border-t pt-4">
          <p className="text-sm font-semibold text-slate-700 mb-2">최근 배포 이력</p>
          <ul className="space-y-2 text-sm">
            {popAnnouncements.length === 0 && <li className="text-slate-400">이력 없음</li>}
            {popAnnouncements.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 border rounded-lg p-2">
                <span className="text-slate-600">
                  #{a.id} {a.is_active ? <b className="text-emerald-600">ON</b> : <span className="text-slate-400">off</span>}{" "}
                  {(a.message || "").slice(0, 48)}
                  {(a.message || "").length > 48 ? "…" : ""}
                </span>
                {a.is_active ? (
                  <button
                    type="button"
                    onClick={() => deactivateAnnouncement(a.id)}
                    className="text-xs px-2 py-1 rounded border border-slate-300 hover:bg-slate-50"
                  >
                    끄기
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="grid md:grid-cols-3 gap-4">
        <TrendCard title="일간 트렌드(30일)" items={trends.daily} />
        <TrendCard title="주간 트렌드(최근)" items={trends.weekly} />
        <TrendCard title="월간 트렌드(1년)" items={trends.monthly} />
      </section>

      <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-4">최근 요청 (상태 관리)</h2>
        <div className="space-y-3">
          {overview.recent_requests.map((r) => (
            <div key={r.repair_request_id} className="border rounded-xl p-3 flex items-center justify-between gap-3">
              <div>
                <p className="font-bold">{r.building_name || "건물명 미확인"}</p>
                <p className="text-xs text-slate-500">
                  ID {r.repair_request_id} / requester {r.requester_id || "guest"} / {r.region_summary}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  defaultValue={r.status}
                  onChange={(e) => updateRequestStatus(r.repair_request_id, e.target.value)}
                  className="border rounded-lg px-2 py-1 text-sm"
                >
                  {["draft", "requested", "bidding", "matched", "repairing", "completed", "cancelled"].map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-4">회원 관리 (역할 변경)</h2>
        <div className="space-y-3">
          {users.map((u) => (
            <div key={u.id} className="border rounded-xl p-3 flex items-center justify-between gap-3">
              <div>
                <p className="font-bold">{u.name || "이름 미입력"} ({u.role || "미설정"})</p>
                <p className="text-xs text-slate-500">
                  {u.company_name || "-"} / {u.phone_number || "-"} / {u.id}
                </p>
                <p className={`text-xs font-semibold mt-1 ${u.is_active ? "text-emerald-600" : "text-rose-600"}`}>
                  {u.is_active ? "활성" : "비활성"}
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => updateUserRole(u.id, "requester")}
                  className="px-3 py-1 rounded-lg text-sm bg-blue-50 text-blue-700 border border-blue-200"
                >
                  의뢰인
                </button>
                <button
                  onClick={() => updateUserRole(u.id, "contractor")}
                  className="px-3 py-1 rounded-lg text-sm bg-green-50 text-green-700 border border-green-200"
                >
                  업체
                </button>
                {u.is_active ? (
                  <button
                    onClick={() => updateUserActive(u.id, false)}
                    className="px-3 py-1 rounded-lg text-sm bg-rose-50 text-rose-700 border border-rose-200"
                  >
                    비활성
                  </button>
                ) : (
                  <button
                    onClick={() => updateUserActive(u.id, true)}
                    className="px-3 py-1 rounded-lg text-sm bg-emerald-50 text-emerald-700 border border-emerald-200"
                  >
                    재활성
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Card({ title, value }: { title: string; value: number }) {
  return (
    <div className="bg-white border rounded-2xl p-5">
      <p className="text-sm text-slate-500">{title}</p>
      <p className="text-3xl font-black text-slate-900 mt-2">{value.toLocaleString()}</p>
    </div>
  );
}

function TrendCard({
  title,
  items,
}: {
  title: string;
  items: { label: string; total: number; matched: number; completed: number }[];
}) {
  const list = items.slice(-8);
  const max = Math.max(1, ...list.map((i) => i.total));
  return (
    <div className="bg-white border rounded-2xl p-4">
      <p className="text-sm font-semibold text-slate-700 mb-3">{title}</p>
      <div className="space-y-2">
        {list.length === 0 && <p className="text-xs text-slate-400">데이터 없음</p>}
        {list.map((i) => (
          <div key={i.label}>
            <div className="flex justify-between text-xs text-slate-500 mb-1">
              <span>{i.label}</span>
              <span>T:{i.total} M:{i.matched} C:{i.completed}</span>
            </div>
            <div className="h-2 bg-slate-100 rounded">
              <div
                className="h-2 bg-indigo-500 rounded"
                style={{ width: `${Math.max(4, Math.round((i.total / max) * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
