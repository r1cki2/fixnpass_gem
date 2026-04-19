"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";

type Row = {
  id: number;
  title: string;
  created_at: string;
  is_mine: boolean;
  reply_status_kr?: string;
};

export default function InquiryListPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loggedIn, setLoggedIn] = useState(false);
  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const t = data.session?.access_token ?? null;
      setLoggedIn(Boolean(t));
      const headers: HeadersInit = {};
      if (t) headers.Authorization = `Bearer ${t}`;
      const res = await fetch(`${baseUrl}/api/inquiries`, { headers });
      const json = await res.json();
      setRows(json.data || []);
    })();
  }, [baseUrl]);

  return (
    <div className="max-w-3xl mx-auto py-10 px-4">
      <div className="flex items-center justify-between gap-4 mb-8">
        <h1 className="text-2xl font-black text-slate-900">고객 문의</h1>
        <div className="flex gap-2">
          {loggedIn ? (
            <Link
              href="/inquiry/new"
              className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-bold hover:bg-blue-700"
            >
              문의 작성
            </Link>
          ) : (
            <Link href="/login" className="px-4 py-2 rounded-xl border border-slate-300 text-sm font-semibold">
              로그인 후 작성
            </Link>
          )}
        </div>
      </div>
      <ul className="space-y-3">
        {rows.length === 0 && <li className="text-slate-500 text-sm">등록된 문의가 없습니다.</li>}
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              href={`/inquiry/${r.id}`}
              className="block bg-white border border-slate-200 rounded-xl p-4 hover:border-blue-300 transition-colors"
            >
              <div className="flex justify-between gap-2 flex-wrap items-center">
                <span className="font-semibold text-slate-900">{r.title}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {r.is_mine && r.reply_status_kr && (
                    <span
                      className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                        r.reply_status_kr === "답변완료"
                          ? "bg-emerald-100 text-emerald-800"
                          : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      내 문의 · {r.reply_status_kr}
                    </span>
                  )}
                  {r.is_mine && (
                    <span className="text-xs font-bold text-blue-600">내 글</span>
                  )}
                </div>
              </div>
              <p className="text-xs text-slate-400 mt-2">
                {r.created_at ? new Date(r.created_at).toLocaleString("ko-KR") : ""}
              </p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
