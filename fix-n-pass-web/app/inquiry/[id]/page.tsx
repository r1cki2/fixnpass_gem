"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Reply = { id: number; body: string; created_at: string; is_admin: boolean };
type Detail = {
  id: number;
  title: string;
  body: string;
  created_at: string;
  is_mine: boolean;
  replies: Reply[];
};

export default function InquiryDetailPage() {
  const params = useParams();
  const id = params.id as string;
  const [data, setData] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [token, setToken] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [msg, setMsg] = useState("");
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
    await load(token);
  };

  if (loading) {
    return <div className="p-10 text-center text-slate-500">불러오는 중...</div>;
  }
  if (!data) {
    return <div className="p-10 text-center text-slate-500">문의를 찾을 수 없습니다.</div>;
  }

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <Link href="/inquiry" className="text-sm text-blue-600 font-semibold hover:underline mb-6 inline-block">
        ← 목록
      </Link>
      <article className="bg-white border border-slate-200 rounded-2xl p-6 mb-6">
        <h1 className="text-xl font-black text-slate-900 mb-2">{data.title}</h1>
        <p className="text-xs text-slate-400 mb-4">
          {data.created_at ? new Date(data.created_at).toLocaleString("ko-KR") : ""}
        </p>
        <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{data.body}</p>
      </article>

      <section className="space-y-4">
        <h2 className="text-lg font-bold text-slate-800">답변</h2>
        {data.replies.length === 0 && <p className="text-sm text-slate-500">아직 답변이 없습니다.</p>}
        {data.replies.map((r) => (
          <div
            key={r.id}
            className={`rounded-xl p-4 border ${
              r.is_admin ? "bg-indigo-50 border-indigo-200" : "bg-slate-50 border-slate-200"
            }`}
          >
            <div className="flex justify-between text-xs text-slate-500 mb-2">
              <span className="font-bold text-slate-700">{r.is_admin ? "관리자" : "답변"}</span>
              <span>{r.created_at ? new Date(r.created_at).toLocaleString("ko-KR") : ""}</span>
            </div>
            <p className="text-sm text-slate-800 whitespace-pre-wrap">{r.body}</p>
          </div>
        ))}
      </section>

      {isAdmin && (
        <div className="mt-8 bg-amber-50 border border-amber-200 rounded-2xl p-5">
          <h3 className="font-bold text-amber-900 mb-2">관리자 답변</h3>
          <textarea
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 min-h-[100px] mb-2 bg-white"
            placeholder="답변 내용을 입력하세요."
          />
          {msg && <p className="text-sm text-rose-600 mb-2">{msg}</p>}
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
