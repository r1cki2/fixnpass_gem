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
type MailCatalogItem = {
  event_type: string;
  label: string;
  trigger: string;
  recipient: string;
  queue_tracked: boolean;
};
type MailingRow = {
  notification_id: number;
  event_type: string;
  event_label: string;
  event_trigger: string;
  recipient_type: string;
  recipient_name: string;
  user_id: string;
  status: string;
  created_at: string;
  mail_meta: {
    channel?: string;
    immediate_attempted?: boolean;
    immediate_attempted_at?: string;
    immediate_sent?: boolean;
    immediate_sent_at?: string;
    immediate_error?: string;
    cron_attempted_at?: string;
    cron_sent?: boolean;
    cron_sent_at?: string;
    cron_error?: string;
    cron_attempt_count?: number;
    last_attempt_type?: string;
    last_attempt_at?: string;
    last_attempt_success?: boolean;
  };
};
type AdminMailRecipient = {
  user_id: string;
  email: string;
  is_master: boolean;
  mail_enabled: boolean;
};

const REQUEST_STATUSES = ["draft", "requested", "bidding", "matched", "repairing", "completed", "cancelled"];

export default function AdminPage() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [authUsers, setAuthUsers] = useState<any[]>([]);
  const [adminInquiries, setAdminInquiries] = useState<any[]>([]);
  const [trends, setTrends] = useState<Trends>({ daily: [], weekly: [], monthly: [] });
  const [loading, setLoading] = useState(true);
  const [requireContractorApproval, setRequireContractorApproval] = useState(true);
  const [popTitle, setPopTitle] = useState("");
  const [popMessage, setPopMessage] = useState("");
  const [popAnnouncements, setPopAnnouncements] = useState<any[]>([]);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [selectedRequestIds, setSelectedRequestIds] = useState<number[]>([]);
  const [bulkStatus, setBulkStatus] = useState("requested");
  const [roleFilter, setRoleFilter] = useState<"all" | "requester" | "contractor">("all");
  const [approvalFilter, setApprovalFilter] = useState<"all" | "pending" | "active">("all");
  const [userSearch, setUserSearch] = useState("");
  const [actionLogs, setActionLogs] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState<"requests" | "inquiries" | "mail" | "ops" | "stats">("requests");
  const [adminRequests, setAdminRequests] = useState<any[]>([]);
  const [reqStatusFilter, setReqStatusFilter] = useState("ALL");
  const [reqSearch, setReqSearch] = useState("");
  const [grantUserId, setGrantUserId] = useState("");
  const [isMasterAdmin, setIsMasterAdmin] = useState(false);
  const [allowedTabs, setAllowedTabs] = useState<Array<"requests" | "inquiries" | "mail" | "ops" | "stats">>([
    "requests",
    "inquiries",
  ]);
  const [mailings, setMailings] = useState<MailingRow[]>([]);
  const [mailCatalog, setMailCatalog] = useState<MailCatalogItem[]>([]);
  const [mailRecipients, setMailRecipients] = useState<AdminMailRecipient[]>([]);
  const [mailStatusFilter, setMailStatusFilter] = useState("ALL");
  const [mailEventFilter, setMailEventFilter] = useState("ALL");
  const [actionMessage, setActionMessage] = useState("");

  const baseUrl = useMemo(() => process.env.NEXT_PUBLIC_API_BASE_URL, []);
  const authHeader = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
  const runAction = async (message: string, fn: () => Promise<void>) => {
    try {
      setActionMessage(message);
      await fn();
    } finally {
      setActionMessage("");
    }
  };

  const fetchAll = async (t: string) => {
    const [oRes, aRes, sRes, tRes, pRes, iRes, lRes, rRes, mRes, mrRes] = await Promise.all([
      fetch(`${baseUrl}/api/admin/overview`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/auth-users`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/settings/contractor-approval`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/stats/trends`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/site-announcements`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/inquiries`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/action-logs`, { headers: authHeader(t) }),
      fetch(`${baseUrl}/api/admin/requests?status=${encodeURIComponent(reqStatusFilter)}`, { headers: authHeader(t) }),
      fetch(
        `${baseUrl}/api/admin/mailings?status=${encodeURIComponent(mailStatusFilter)}&event_type=${encodeURIComponent(mailEventFilter)}`,
        { headers: authHeader(t) },
      ),
      fetch(`${baseUrl}/api/admin/mail-recipients`, { headers: authHeader(t) }),
    ]);
    if ([oRes, aRes].some((r) => r.status === 401 || r.status === 403)) {
      alert("관리자 권한이 없습니다.");
      router.replace("/");
      return;
    }
    const oJson = await oRes.json();
    const aJson = await aRes.json();
    const tJson = await tRes.json();
    if (sRes.ok) {
      const sJson = await sRes.json();
      setRequireContractorApproval(Boolean(sJson.data?.require_approval));
    }
    if (pRes.ok) setPopAnnouncements((await pRes.json()).data || []);
    if (iRes.ok) setAdminInquiries((await iRes.json()).data || []);
    if (lRes.ok) setActionLogs((await lRes.json()).data || []);
    if (rRes.ok) setAdminRequests((await rRes.json()).data || []);
    if (mRes.ok) {
      const mJson = await mRes.json();
      setMailings(mJson?.data?.rows || []);
      setMailCatalog(mJson?.data?.catalog || []);
    }
    if (mrRes.ok) setMailRecipients((await mrRes.json()).data || []);
    setOverview(oJson.data);
    setAuthUsers(aJson.data || []);
    setTrends(tJson.data || { daily: [], weekly: [], monthly: [] });
  };

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const accessToken = data.session?.access_token;
      if (!accessToken) return router.replace("/login");
      setToken(accessToken);
      const sRes = await fetch(`${baseUrl}/api/admin/session`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!sRes.ok) return router.replace("/");
      const sJson = await sRes.json();
      const tabs = (sJson?.data?.allowed_tabs || ["requests", "inquiries"]) as Array<
        "requests" | "inquiries" | "mail" | "ops" | "stats"
      >;
      setAllowedTabs(tabs);
      setIsMasterAdmin(Boolean(sJson?.data?.is_master));
      if (!tabs.includes(activeTab)) setActiveTab(tabs[0] || "requests");
      await fetchAll(accessToken);
      setLoading(false);
    })();
  }, [router, baseUrl, reqStatusFilter, mailStatusFilter, mailEventFilter]);

  const updateContractorApprovalSetting = async (next: boolean) => {
    await runAction("설정을 저장하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/settings/contractor-approval`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ require_approval: next }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "설정 저장 실패");
      setRequireContractorApproval(next);
    });
  };

  const updateUserRole = async (userId: string, role: "requester" | "contractor") => {
    await runAction("회원 역할을 변경하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/role`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ role }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "역할 변경 실패");
      await fetchAll(token);
    });
  };

  const updateUserActive = async (userId: string, isActive: boolean, forceDuplicateOk = false) => {
    await runAction("회원 상태를 변경하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/users/${userId}/active`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ is_active: isActive, force_duplicate_ok: forceDuplicateOk }),
      });
      const json = await res.json();
      if (res.status === 409) {
        if (confirm(`${json.detail}\n\n중복 상호임을 확인하고 승인할까요?`)) {
          return updateUserActive(userId, isActive, true);
        }
        return;
      }
      if (!res.ok) return alert(json.detail || "계정 상태 변경 실패");
      await fetchAll(token);
    });
  };

  const removeAuthUser = async (userId: string, email: string | null | undefined) => {
    const em = (email || "").trim().toLowerCase();
    if (!em) return alert("이메일이 없는 계정은 이 경로로 삭제할 수 없습니다.");
    const typed = window.prompt(`계정을 삭제하려면 아래 이메일을 정확히 입력하세요.\n\n${em}`);
    if (!typed || typed.trim().toLowerCase() !== em) return alert("이메일이 일치하지 않아 삭제를 취소합니다.");
    if (!window.confirm("정말 이 계정을 삭제할까요?")) return;
    const res = await fetch(`${baseUrl}/api/admin/auth-users/${userId}/remove`, {
      method: "POST",
      headers: authHeader(token),
      body: JSON.stringify({ confirm_email: typed.trim().toLowerCase() }),
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "삭제 실패");
    await fetchAll(token);
  };

  const bulkDeleteUsers = async () => {
    if (selectedUserIds.length === 0) return alert("삭제할 회원을 선택하세요.");
    const typed = window.prompt(`삭제를 진행하려면 DELETE ${selectedUserIds.length} 를 입력하세요.`);
    if (typed !== `DELETE ${selectedUserIds.length}`) return alert("확인 문구가 일치하지 않아 취소되었습니다.");
    await runAction("회원 일괄 삭제를 처리하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/auth-users/bulk-remove`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ user_ids: selectedUserIds }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "일괄 삭제 실패");
      setSelectedUserIds([]);
      alert(`삭제 요청 ${json.data?.requested}건 중 ${json.data?.removed}건 처리`);
      await fetchAll(token);
    });
  };

  const bulkUpdateRequests = async () => {
    if (selectedRequestIds.length === 0) return alert("상태 변경할 요청을 선택하세요.");
    await runAction("요청 상태를 일괄 변경하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/requests/bulk-status`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ request_ids: selectedRequestIds, status: bulkStatus }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "일괄 상태 변경 실패");
      setSelectedRequestIds([]);
      await fetchAll(token);
    });
  };

  const bulkRequestAction = async (action: "hide" | "delete") => {
    if (selectedRequestIds.length === 0) return alert("처리할 요청을 선택하세요.");
    if (!confirm(`${selectedRequestIds.length}건에 대해 ${action === "hide" ? "비공개" : "삭제"}를 진행할까요?`)) return;
    await runAction(`${action === "hide" ? "비공개" : "삭제"} 처리를 진행하는 중...`, async () => {
      const res = await fetch(`${baseUrl}/api/admin/requests/bulk-action`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ request_ids: selectedRequestIds, action }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "처리 실패");
      setSelectedRequestIds([]);
      await fetchAll(token);
    });
  };

  const deploySitePopup = async () => {
    await runAction("팝업 공지를 배포하는 중...", async () => {
      const res = await fetch(`${baseUrl}/api/admin/site-announcements/deploy`, {
        method: "POST",
        headers: authHeader(token),
        body: JSON.stringify({ title: popTitle.trim() || undefined, message: popMessage }),
      });
      const json = await res.json();
      if (!res.ok) return alert(json.detail || "배포 실패");
      setPopTitle("");
      setPopMessage("");
      await fetchAll(token);
    });
  };

  if (loading) return <div className="p-10">관리자 데이터를 불러오는 중...</div>;
  if (!overview) return <div className="p-10">데이터를 불러오지 못했습니다.</div>;

  const requests = overview.recent_requests || [];
  const filteredUsers = authUsers.filter((u) => {
    if (roleFilter !== "all" && u.role !== roleFilter) return false;
    if (approvalFilter === "pending" && (u.role !== "contractor" || u.is_active)) return false;
    if (approvalFilter === "active" && !u.is_active) return false;
    const q = userSearch.trim().toLowerCase();
    if (!q) return true;
    return [u.email, u.name, u.id, u.company_name, u.phone_number, u.office_phone_number]
      .some((v) => String(v || "").toLowerCase().includes(q));
  });
  const visibleRequests = adminRequests.filter((r) => {
    const q = reqSearch.trim().toLowerCase();
    if (!q) return true;
    return [
      r.repair_request_id,
      r.status,
      r.building_name,
      r.region_summary,
      r.requester_name,
      ...(r.bid_companies || []),
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

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
      <div className="flex gap-2">
        {allowedTabs.includes("requests") && <button onClick={() => setActiveTab("requests")} className={`px-3 py-1 rounded ${activeTab === "requests" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>회원 및 견적 관리</button>}
        {allowedTabs.includes("inquiries") && <button onClick={() => setActiveTab("inquiries")} className={`px-3 py-1 rounded ${activeTab === "inquiries" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>고객 문의 관리</button>}
        {allowedTabs.includes("mail") && <button onClick={() => setActiveTab("mail")} className={`px-3 py-1 rounded ${activeTab === "mail" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>메일링 관리</button>}
        {allowedTabs.includes("ops") && <button onClick={() => setActiveTab("ops")} className={`px-3 py-1 rounded ${activeTab === "ops" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>승인/팝업/운영</button>}
        {allowedTabs.includes("stats") && <button onClick={() => setActiveTab("stats")} className={`px-3 py-1 rounded ${activeTab === "stats" ? "bg-slate-900 text-white" : "bg-slate-100"}`}>서비스 사용 현황</button>}
      </div>

      {activeTab === "mail" && <section className="bg-white border rounded-2xl p-5 space-y-4">
        <h2 className="text-xl font-bold">메일링 관리</h2>
        <div className="grid md:grid-cols-3 gap-2">
          <select value={mailStatusFilter} onChange={(e) => setMailStatusFilter(e.target.value)} className="border rounded px-2 py-1 text-sm">
            <option value="ALL">전체 상태</option>
            <option value="pending">pending</option>
            <option value="failed">failed</option>
            <option value="sent">sent</option>
          </select>
          <select value={mailEventFilter} onChange={(e) => setMailEventFilter(e.target.value)} className="border rounded px-2 py-1 text-sm">
            <option value="ALL">전체 이벤트</option>
            {mailCatalog.map((c) => <option key={c.event_type} value={c.event_type}>{c.label}</option>)}
          </select>
          <button onClick={() => fetchAll(token)} className="px-3 py-1 rounded bg-slate-900 text-white text-sm">새로고침</button>
        </div>

        <div className="border rounded-xl p-3">
          <p className="font-semibold mb-2">메일 이벤트 카탈로그</p>
          <div className="max-h-[220px] overflow-y-auto space-y-2 text-sm">
            {mailCatalog.map((c) => (
              <div key={c.event_type} className="border rounded p-2">
                <div className="font-semibold">{c.label} <span className="text-xs text-slate-500">({c.event_type})</span></div>
                <div className="text-xs text-slate-600">수신자: {c.recipient} / 추적: {c.queue_tracked ? "queue 기반" : "즉시발송 전용"}</div>
                <div className="text-xs text-slate-600">{c.trigger}</div>
              </div>
            ))}
          </div>
        </div>

        {isMasterAdmin && <div className="border rounded-xl p-3">
          <p className="font-semibold mb-2">관리자 수신인 설정 (마스터 전용)</p>
          <div className="space-y-2 text-sm">
            {mailRecipients.map((r) => (
              <div key={r.user_id} className="flex items-center justify-between border rounded p-2">
                <div>
                  <div className="font-semibold">{r.email}</div>
                  <div className="text-xs text-slate-500">{r.is_master ? "Master Admin (항상 수신)" : `user_id: ${r.user_id}`}</div>
                </div>
                <button
                  disabled={r.is_master}
                  onClick={async () => {
                    await runAction("관리자 수신인 설정을 변경하는 중...", async () => {
                      const res = await fetch(`${baseUrl}/api/admin/master/mail-recipients`, {
                        method: "POST",
                        headers: authHeader(token),
                        body: JSON.stringify({ user_id: r.user_id, enabled: !r.mail_enabled }),
                      });
                      const json = await res.json();
                      if (!res.ok) return alert(json.detail || "설정 변경 실패");
                      await fetchAll(token);
                    });
                  }}
                  className={`px-3 py-1 rounded text-xs font-semibold ${r.mail_enabled ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-700"} ${r.is_master ? "opacity-50 cursor-not-allowed" : ""}`}
                >
                  {r.mail_enabled ? "수신중 (클릭 시 제외)" : "제외됨 (클릭 시 수신)"}
                </button>
              </div>
            ))}
          </div>
        </div>}

        <div className="overflow-x-auto max-h-[560px] overflow-y-auto">
          <table className="w-full text-xs min-w-[1450px]">
            <thead><tr className="border-b bg-slate-50">
              <th className="py-2 px-2">ID</th><th className="py-2 px-2">이벤트</th><th className="py-2 px-2">발생일시</th><th className="py-2 px-2">즉시발송</th>
              <th className="py-2 px-2">즉시결과/오류</th><th className="py-2 px-2">크론시도</th><th className="py-2 px-2">크론성공여부</th>
              <th className="py-2 px-2">최종상태</th><th className="py-2 px-2">수신자</th><th className="py-2 px-2">채널</th>
            </tr></thead>
            <tbody>
              {mailings.map((m) => (
                <tr key={m.notification_id} className="border-b align-top">
                  <td className="py-2 px-2 font-mono">{m.notification_id}</td>
                  <td className="py-2 px-2">
                    <div className="font-semibold">{m.event_label}</div>
                    <div className="text-slate-500">{m.event_type}</div>
                  </td>
                  <td className="py-2 px-2">{m.created_at ? new Date(m.created_at).toLocaleString("ko-KR") : "-"}</td>
                  <td className="py-2 px-2">{m.mail_meta?.immediate_attempted ? "Y" : "N"}{m.mail_meta?.immediate_attempted_at ? ` (${new Date(m.mail_meta.immediate_attempted_at).toLocaleString("ko-KR")})` : ""}</td>
                  <td className="py-2 px-2">
                    {m.mail_meta?.immediate_sent ? "성공" : "실패/대기"}
                    {m.mail_meta?.immediate_error && <div className="text-rose-600 break-all">{m.mail_meta.immediate_error}</div>}
                  </td>
                  <td className="py-2 px-2">
                    {m.mail_meta?.cron_attempt_count || 0}회
                    {m.mail_meta?.cron_attempted_at && <div>{new Date(m.mail_meta.cron_attempted_at).toLocaleString("ko-KR")}</div>}
                  </td>
                  <td className="py-2 px-2">
                    {m.mail_meta?.cron_sent ? "성공" : (m.mail_meta?.cron_attempt_count ? "실패" : "-")}
                    {m.mail_meta?.cron_error && <div className="text-rose-600 break-all">{m.mail_meta.cron_error}</div>}
                  </td>
                  <td className="py-2 px-2 font-semibold">{m.status}</td>
                  <td className="py-2 px-2">
                    {m.recipient_name || "-"}
                    <div className="text-slate-500">{m.user_id}</div>
                  </td>
                  <td className="py-2 px-2">{m.mail_meta?.channel || "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>}

      {activeTab === "ops" && isMasterAdmin && <section className="bg-white border rounded-2xl p-5 space-y-3">
        <h2 className="text-xl font-bold">회원가입 승인 설정</h2>
        <p className="text-sm text-slate-500">현재 상태: {requireContractorApproval ? "ON (관리자 승인 필요)" : "OFF"}</p>
        <div className="flex items-center gap-2">
          <button onClick={() => updateContractorApprovalSetting(true)} className={`px-3 py-1 rounded-lg text-xs font-bold ${requireContractorApproval ? "bg-emerald-600 text-white" : "bg-slate-100 text-slate-600"}`}>ON</button>
          <button onClick={() => updateContractorApprovalSetting(false)} className={`px-3 py-1 rounded-lg text-xs font-bold ${!requireContractorApproval ? "bg-rose-600 text-white" : "bg-slate-100 text-slate-600"}`}>OFF</button>
        </div>
      </section>}

      {activeTab === "requests" && <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-3">최근 요청 (상태 관리)</h2>
        <div className="flex items-center gap-2 mb-3">
          <select value={reqStatusFilter} onChange={(e) => setReqStatusFilter(e.target.value)} className="border rounded px-2 py-1 text-sm">
            <option value="ALL">전체 상태</option>
            {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={reqSearch} onChange={(e) => setReqSearch(e.target.value)} className="border rounded px-2 py-1 text-sm flex-1" placeholder="ID/의뢰인명/건물명/소재지/업체명 검색" />
          <div className="ml-auto flex items-center gap-2">
            <select value={bulkStatus} onChange={(e) => setBulkStatus(e.target.value)} className="border rounded px-2 py-1 text-sm">
              {REQUEST_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <button onClick={bulkUpdateRequests} className="px-3 py-1 rounded bg-indigo-600 text-white text-xs font-semibold">상태 일괄변경 확정</button>
            <button onClick={() => bulkRequestAction("hide")} className="px-3 py-1 rounded bg-amber-600 text-white text-xs font-semibold">비공개</button>
            <button onClick={() => bulkRequestAction("delete")} className="px-3 py-1 rounded bg-rose-600 text-white text-xs font-semibold">삭제</button>
          </div>
        </div>
        <div className="max-h-[520px] overflow-y-auto space-y-3 pr-1">
          {visibleRequests.map((r: any) => (
            <div key={r.repair_request_id} className="border rounded-xl p-3 flex items-center justify-between gap-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selectedRequestIds.includes(r.repair_request_id)}
                  onChange={(e) =>
                    setSelectedRequestIds((prev) => e.target.checked ? [...prev, r.repair_request_id] : prev.filter((x) => x !== r.repair_request_id))
                  }
                />
                <span className="font-bold">{r.building_name || "건물명 미확인"}</span>
              </label>
              <span className="text-xs text-slate-500 text-right">
                ID {r.repair_request_id} / {r.status} / {r.is_hidden ? "비공개" : "공개"}<br />
                의뢰인: {r.requester_name || "-"} / 소재지: {r.region_summary || "-"}<br />
                견적업체: {(r.bid_companies || []).join(", ") || "-"}
              </span>
            </div>
          ))}
        </div>
      </section>}

      {activeTab === "inquiries" && <section className="bg-white border rounded-2xl p-5 overflow-x-auto">
        <h2 className="text-xl font-bold mb-4">고객 문의 (관리자)</h2>
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="border-b bg-slate-50"><th className="py-2 px-2">상태</th><th className="py-2 px-2">제목</th><th className="py-2 px-2">작성자</th><th className="py-2 px-2">일시</th><th className="py-2 px-2">보기</th></tr></thead>
          <tbody>
            {adminInquiries.map((q) => (
              <tr key={q.id} className="border-b">
                <td className="py-2 px-2">{q.reply_status_kr}</td>
                <td className="py-2 px-2 max-w-[280px] truncate">{q.title}</td>
                <td className="py-2 px-2 text-xs">{q.author_email || "-"}</td>
                <td className="py-2 px-2 text-xs">{q.created_at ? new Date(q.created_at).toLocaleString("ko-KR") : ""}</td>
                <td className="py-2 px-2"><a href={`/inquiry/${q.id}`} className="text-indigo-600 font-semibold">열기</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>}

      {activeTab === "requests" && <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-4">회원 관리 (Auth 연동)</h2>
        <div className="grid md:grid-cols-4 gap-2 mb-3">
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as any)} className="border rounded px-2 py-2 text-sm">
            <option value="all">전체 역할</option><option value="requester">수리 의뢰인</option><option value="contractor">수리 업체</option>
          </select>
          <select value={approvalFilter} onChange={(e) => setApprovalFilter(e.target.value as any)} className="border rounded px-2 py-2 text-sm">
            <option value="all">전체 상태</option><option value="pending">승인 필요(업체)</option><option value="active">활성 계정</option>
          </select>
          <input value={userSearch} onChange={(e) => setUserSearch(e.target.value)} className="border rounded px-2 py-2 text-sm md:col-span-2" placeholder="이메일/이름/UUID/회사/전화 검색" />
        </div>
        <div className="flex items-center gap-2 mb-3">
          <button onClick={bulkDeleteUsers} className="px-3 py-1 rounded bg-rose-600 text-white text-xs font-semibold">선택 회원 일괄 삭제(임시보관)</button>
          <span className="text-xs text-slate-500">선택 {selectedUserIds.length}명</span>
        </div>
        <div className="overflow-x-auto max-h-[620px] overflow-y-auto">
          <table className="w-full text-sm min-w-[1420px]">
            <thead><tr className="border-b bg-slate-50">
              <th className="py-2 px-2"></th><th className="py-2 px-2">이름</th><th className="py-2 px-2">역할</th><th className="py-2 px-2">권한표시</th>
              <th className="py-2 px-2">회사명</th><th className="py-2 px-2">소재지</th><th className="py-2 px-2">휴대폰</th><th className="py-2 px-2">사무실 전화</th><th className="py-2 px-2">상태</th><th className="py-2 px-2">액션</th><th className="py-2 px-2">이메일</th><th className="py-2 px-2">UUID</th>
            </tr></thead>
            <tbody>
              {filteredUsers.map((u) => (
                <tr key={u.id} className="border-b align-top">
                  <td className="py-2 px-2"><input type="checkbox" checked={selectedUserIds.includes(u.id)} onChange={(e) => setSelectedUserIds((prev) => e.target.checked ? [...prev, u.id] : prev.filter((x) => x !== u.id))} /></td>
                  <td className="py-2 px-2">{u.name || "-"}</td>
                  <td className="py-2 px-2">
                    {u.is_admin ? (
                      <span className="text-xs font-semibold">{u.is_master_admin ? "Master Admin" : "Administrator"}</span>
                    ) : (
                      <select className="border rounded px-1 py-1 text-xs" value={u.role || "requester"} onChange={(e) => updateUserRole(u.id, e.target.value as any)}><option value="requester">수리 의뢰인</option><option value="contractor">수리 업체</option></select>
                    )}
                  </td>
                  <td className="py-2 px-2 text-xs font-semibold">{u.role_display || "-"}</td>
                  <td className="py-2 px-2 text-xs">{u.company_name || "-"}</td>
                  <td className="py-2 px-2 text-xs">{u.business_location || "-"}</td>
                  <td className="py-2 px-2 text-xs">{u.phone_number || "-"}</td>
                  <td className="py-2 px-2 text-xs">{u.office_phone_number || "-"}</td>
                  <td className="py-2 px-2 text-xs">{u.role === "contractor" && !u.is_active ? "승인대기/비활성" : u.is_active ? "활성" : "비활성"}</td>
                  <td className="py-2 px-2 space-y-1">
                    {u.role === "contractor" && !u.is_active && <button className="block w-full px-2 py-1 rounded border text-xs text-emerald-700" onClick={() => updateUserActive(u.id, true)}>가입 승인</button>}
                    <button className="block w-full px-2 py-1 rounded border text-xs" onClick={() => updateUserActive(u.id, !u.is_active)}>{u.is_active ? "비활성" : "재활성"}</button>
                    <button className="block w-full px-2 py-1 rounded border border-rose-200 text-xs text-rose-700" onClick={() => removeAuthUser(u.id, u.email)}>계정 삭제</button>
                  </td>
                  <td className="py-2 px-2 break-all text-xs">{u.email || "-"}</td>
                  <td className="py-2 px-2 text-xs font-mono break-all">{u.id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>}

      {activeTab === "ops" && isMasterAdmin && <section className="bg-white border rounded-2xl p-5 space-y-4">
        <h2 className="text-xl font-bold">관리자 권한 부여(마스터 전용)</h2>
        <div className="flex gap-2">
          <input value={grantUserId} onChange={(e) => setGrantUserId(e.target.value)} className="border rounded px-3 py-2 text-sm flex-1" placeholder="관리자로 등록할 사용자 UUID" />
          <button
            onClick={async () => {
              await runAction("관리자 권한을 부여하는 중...", async () => {
                const res = await fetch(`${baseUrl}/api/admin/master/grant-admin`, {
                  method: "POST",
                  headers: authHeader(token),
                  body: JSON.stringify({ user_id: grantUserId }),
                });
                const json = await res.json();
                if (!res.ok) return alert(json.detail || "권한 부여 실패");
                alert("관리자 권한을 부여했습니다.");
                setGrantUserId("");
                await fetchAll(token);
              });
            }}
            className="px-3 py-2 rounded bg-slate-900 text-white text-sm"
          >
            관리자 등록
          </button>
        </div>
      </section>}

      {activeTab === "ops" && isMasterAdmin && <section className="bg-white border rounded-2xl p-5 space-y-4">
        <h2 className="text-xl font-bold">첫 화면 팝업 (알림 배포)</h2>
        <input value={popTitle} onChange={(e) => setPopTitle(e.target.value)} placeholder="제목 (선택)" className="w-full border rounded-lg px-3 py-2 text-sm" />
        <textarea value={popMessage} onChange={(e) => setPopMessage(e.target.value)} placeholder="팝업 본문" className="w-full border rounded-lg px-3 py-2 text-sm min-h-[100px]" />
        <button onClick={deploySitePopup} className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold text-sm">배포하기</button>
        <ul className="space-y-2 text-sm">
          {popAnnouncements.map((a) => (
            <li key={a.id} className="flex items-center justify-between border rounded p-2">
              <span>#{a.id} {a.is_active ? "ON" : "off"} {(a.message || "").slice(0, 48)}</span>
            </li>
          ))}
        </ul>
      </section>}

      {activeTab === "stats" && isMasterAdmin && <section className="grid md:grid-cols-3 gap-4">
        <TrendCard title="일간 트렌드(30일)" items={trends.daily} />
        <TrendCard title="주간 트렌드(최근)" items={trends.weekly} />
        <TrendCard title="월간 트렌드(1년)" items={trends.monthly} />
      </section>}
      {activeTab === "stats" && isMasterAdmin && <section className="bg-white border rounded-2xl p-5">
        <h2 className="text-xl font-bold mb-3">관리자 작업 로그</h2>
        <div className="max-h-[320px] overflow-y-auto space-y-2">
          {actionLogs.map((x) => (
            <div key={x.id} className="border rounded-lg p-2 text-xs">
              <div className="font-semibold">{x.action}</div>
              <div className="text-slate-500">
                {x.admin_email} · {x.created_at ? new Date(x.created_at).toLocaleString("ko-KR") : ""}
              </div>
              <div className="text-slate-600 break-all">{JSON.stringify(x.payload || {})}</div>
            </div>
          ))}
        </div>
      </section>}
      {actionMessage && (
        <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px] flex items-center justify-center">
          <div className="bg-white border rounded-xl px-5 py-4 shadow-xl flex items-center gap-3">
            <span className="inline-block w-5 h-5 border-2 border-slate-300 border-t-blue-600 rounded-full animate-spin" />
            <p className="text-sm font-semibold text-slate-700">{actionMessage}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function Card({ title, value }: { title: string; value: number }) {
  return <div className="bg-white border rounded-2xl p-5"><p className="text-sm text-slate-500">{title}</p><p className="text-3xl font-black text-slate-900 mt-2">{value.toLocaleString()}</p></div>;
}
function TrendCard({ title, items }: { title: string; items: { label: string; total: number; matched: number; completed: number }[] }) {
  const list = items.slice(-8);
  const max = Math.max(1, ...list.map((i) => i.total));
  return (
    <div className="bg-white border rounded-2xl p-4">
      <p className="text-sm font-semibold text-slate-700 mb-3">{title}</p>
      <div className="space-y-2">
        {list.length === 0 && <p className="text-xs text-slate-400">데이터 없음</p>}
        {list.map((i) => (
          <div key={i.label}>
            <div className="flex justify-between text-xs text-slate-500 mb-1"><span>{i.label}</span><span>T:{i.total} M:{i.matched} C:{i.completed}</span></div>
            <div className="h-2 bg-slate-100 rounded"><div className="h-2 bg-indigo-500 rounded" style={{ width: `${Math.max(4, Math.round((i.total / max) * 100))}%` }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
