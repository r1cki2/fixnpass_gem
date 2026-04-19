"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function NewInquiryPage() {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    setLoading(true);
    try {
      const { data } = await supabase.auth.getSession();
      const t = data.session?.access_token;
      if (!t) {
        setMsg("로그인이 필요합니다.");
        setLoading(false);
        return;
      }
      const res = await fetch(`${baseUrl}/api/inquiries`, {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMsg(json.detail || "등록에 실패했습니다.");
        setLoading(false);
        return;
      }
      const id = json.data?.id;
      router.push(id ? `/inquiry/${id}` : "/inquiry");
    } catch {
      setMsg("네트워크 오류입니다.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto py-10 px-4">
      <Link href="/inquiry" className="text-sm text-blue-600 font-semibold hover:underline mb-6 inline-block">
        ← 목록
      </Link>
      <h1 className="text-2xl font-black text-slate-900 mb-6">문의 작성</h1>
      <form onSubmit={submit} className="space-y-4 bg-white border border-slate-200 rounded-2xl p-6">
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">제목</label>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border rounded-lg px-3 py-2"
            required
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">내용</label>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="w-full border rounded-lg px-3 py-2 min-h-[160px]"
            required
          />
        </div>
        {msg && <p className="text-sm text-rose-600">{msg}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 rounded-xl bg-blue-600 text-white font-bold disabled:bg-slate-300"
        >
          {loading ? "등록 중..." : "등록"}
        </button>
      </form>
    </div>
  );
}
