"use client";

import { Suspense, useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { submitPendingQuoteRequest } from "@/lib/pendingQuote";

function safeInternalPath(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/";
  return next;
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setMessage("");

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      setMessage("로그인 실패: 이메일이나 비밀번호를 확인해주세요.");
      setIsLoading(false);
      return;
    }

    const uid = data.user?.id;
    if (uid) {
      const pending = await submitPendingQuoteRequest(uid);
      if (pending.ok) {
        setMessage("로그인되었습니다. 견적 요청을 완료하고 내역으로 이동합니다...");
        setTimeout(() => router.replace("/my-requests"), 600);
        setIsLoading(false);
        return;
      }
      if (pending.error && !pending.skipped) {
        alert(pending.error);
      }
    }

    setMessage("로그인 성공! 이동합니다...");
    const dest = safeInternalPath(searchParams.get("next"));
    setTimeout(() => {
      router.replace(dest);
    }, 600);
    setIsLoading(false);
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-6 bg-white rounded-xl shadow-md border border-gray-200">
      <h1 className="text-3xl font-bold text-center text-gray-800 mb-8">로그인</h1>

      <form className="flex flex-col gap-6" onSubmit={handleLogin}>
        <div>
          <label className="block text-lg font-medium text-gray-700 mb-2">이메일 (로그인 아이디)</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 text-lg border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="이메일 주소를 입력하세요"
            required
          />
        </div>

        <div>
          <label className="block text-lg font-medium text-gray-700 mb-2">비밀번호</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 text-lg border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="비밀번호를 입력하세요 (6자리 이상)"
            required
          />
        </div>

        {message && (
          <div className="text-center font-semibold text-blue-600">{message}</div>
        )}

        <div className="flex flex-col gap-3 mt-4">
          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 rounded-lg text-xl transition-colors disabled:bg-gray-400"
          >
            {isLoading ? "처리 중..." : "로그인"}
          </button>

          <Link
            href="/signup"
            className="w-full text-center bg-gray-100 hover:bg-gray-200 text-gray-800 font-bold py-4 rounded-lg text-xl transition-colors border border-gray-300"
          >
            회원가입 화면으로 이동
          </Link>
        </div>
      </form>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="max-w-md mx-auto mt-20 p-6 text-center text-slate-500">로딩 중...</div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
