"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Reply = {
  id: number;
  body: string;
  created_at: string;
  updated_at?: string | null;
  is_admin: boolean;
};
type TimelineItem = {
  kind: string;
  id: number;
  body: string;
  created_at: string;
  updated_at?: string | null;
  is_admin?: boolean;
};
type Detail = {
  id: number;
  title: string;
  body: string;
  created_at: string;
  is_mine: boolean;
  is_admin_session: boolean;
  replies: Reply[];
  timeline: TimelineItem[];
  reply_status_kr: string;
  can_followup: boolean;
};

export default function InquiryDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [followup, setFollowup] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [msg, setMsg] = useState("");
  const [editingReplyId, setEditingReplyId] = useState<number | null>(null);
  const [editReplyBody, setEditReplyBody] = useState("");
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  const adminEmail = process.env.NEXT_PUBLIC_ADMIN_EMAIL;

  const load = async (t: string | null) => {
    try {
      const headers: HeadersInit = {};
      if (t) headers.Authorization = `Bearer ${t}`;
      const res = await fetch(`${baseUrl}/api/inquiries/${id}`, { headers });
      if (!res.ok) {
        setData(null);
        return;
      }
      const json = await res.json();
      setData(json.data);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      const t = data.session?.access_token ?? null;
      const em = data.session?.user?.email?.toLowerCase();
      setToken(t);
      setIsAdmin(Boolean(adminEmail && em === adminEmail.toLowerCase()));
      await load(t);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, baseUrl, adminEmail]);

  const sendReply = async () => {
    setMsg("");
    if (!token || !reply.trim()) return;
    const res = await fetch(`${baseUrl}/api/inquiries/${id}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: reply.trim() }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMsg(json.detail || "답변 등록 실패");
      return;
    }
    setReply("");
    setMsg("");
    await load(token);
  };

  const sendFollowup = async () => {
    setMsg("");
    if (!token || !followup.trim()) return;
    const res = await fetch(`${baseUrl}/api/inquiries/${id}/followup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: followup.trim() }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMsg(json.detail || "추가 문의 등록 실패");
      return;
    }
    setFollowup("");
    setMsg("");
    await load(token);
  };

  const saveReplyEdit = async (replyId: number) => {
    setMsg("");
    if (!token || !editReplyBody.trim()) return;
    const res = await fetch(`${baseUrl}/api/admin/inquiry-replies/${replyId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ body: editReplyBody.trim() }),
    });
    const json = await res.json();
    if (!res.ok) {
      setMsg(json.detail || "답변 수정 실패");
      return;
    }
    setEditingReplyId(null);
    setEditReplyBody("");
    setMsg("");
    await load(token);
  };

  if (loading) {
    return <div className="p-10 text-center text-slate-500">불러오는 중...</div>;
  }
  if (!data) {
    return <div className="p-10 text-center text-slate-500">문의를 찾을 수 없습니다.</div>;
  }

  const timeline = data.timeline?.length ? data.timeline : [];

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <Link href="/inquiry" className="text-sm text-blue-600 font-semibold hover:underline mb-6 inline-block">
        ← 목록
      </Link>
      {msg ? (
        <div className="mb-4 rounded-lg bg-rose-50 text-rose-700 text-sm px-3 py-2 border border-rose-200">{msg}</div>
      ) : null}
      <article className="bg-white border border-slate-200 rounded-2xl p-6 mb-6">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <h1 className="text-xl font-black text-slate-900">{data.title}</h1>
          {data.is_mine && (
            <span
              className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                data.reply_status_kr === "답변완료"
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              내 문의 · {data.reply_status_kr}
            </span>
          )}
        </div>
        <p className="text-xs text-slate-400 mb-4">
          {data.created_at ? new Date(data.created_at).toLocaleString("ko-KR") : ""}
        </p>
        <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{data.body}</p>
      </article>

      <section className="space-y-4 mb-8">
        <h2 className="text-lg font-bold text-slate-800">답변 · 추가 문의</h2>
        {timeline.length === 0 && <p className="text-sm text-slate-500">아직 답변이 없습니다.</p>}
        {timeline.map((item) => (
          <div
            key={`${item.kind}-${item.id}`}
            className={`rounded-xl p-4 border ${
              item.kind === "admin_reply"
                ? "bg-indigo-50 border-indigo-200"
                : "bg-slate-50 border-slate-200"
            }`}
          >
            <div className="flex justify-between text-xs text-slate-500 mb-2 gap-2 flex-wrap">
              <span className="font-bold text-slate-700">
                {item.kind === "admin_reply" ? "관리자" : "추가 문의"}
              </span>
              <span>
                {item.created_at ? new Date(item.created_at).toLocaleString("ko-KR") : ""}
                {item.updated_at ? (
                  <span className="text-slate-400 ml-1">
                    (수정 {new Date(item.updated_at).toLocaleString("ko-KR")})
                  </span>
                ) : null}
              </span>
            </div>
            {isAdmin && item.kind === "admin_reply" && editingReplyId === item.id ? (
              <div className="space-y-2">
                <textarea
                  value={editReplyBody}
                  onChange={(e) => setEditReplyBody(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm min-h-[80px]"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => saveReplyEdit(item.id)}
                    className="px-3 py-1 rounded-lg bg-indigo-600 text-white text-sm font-semibold"
                  >
                    저장
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingReplyId(null);
                      setEditReplyBody("");
                    }}
                    className="px-3 py-1 rounded-lg border text-sm"
                  >
                    취소
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-slate-800 whitespace-pre-wrap">{item.body}</p>
            )}
            {isAdmin && item.kind === "admin_reply" && editingReplyId !== item.id && (
              <button
                type="button"
                className="mt-2 text-xs text-indigo-700 font-semibold hover:underline"
                onClick={() => {
                  setEditingReplyId(item.id);
                  setEditReplyBody(item.body);
                }}
              >
                답변 수정
              </button>
            )}
          </div>
        ))}
      </section>

      {data.is_mine && data.can_followup && (
        <div className="mb-8 bg-blue-50 border border-blue-200 rounded-2xl p-5">
          <h3 className="font-bold text-blue-900 mb-2">추가 문의</h3>
          <p className="text-xs text-blue-800 mb-2">답변이 완료된 뒤에만 추가 문의를 남길 수 있습니다.</p>
          <textarea
            value={followup}
            onChange={(e) => setFollowup(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 min-h-[100px] mb-2 bg-white"
            placeholder="추가로 전달할 내용을 입력하세요."
          />
          <button
            type="button"
            onClick={sendFollowup}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white font-semibold text-sm hover:bg-blue-700"
          >
            추가 문의 등록
          </button>
        </div>
      )}

      {isAdmin && (
        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-2xl p-5">
          <h3 className="font-bold text-amber-900 mb-2">관리자 새 답변</h3>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 min-h-[100px] mb-2 bg-white"
            placeholder="답변 내용을 입력하세요."
          />
          <button
            type="button"
            onClick={sendReply}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white font-semibold hover:bg-indigo-700"
          >
            답변 등록
          </button>
        </div>
      )}
    </div>
  );
}
