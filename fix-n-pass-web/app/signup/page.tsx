"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== passwordConfirm) {
      setMessage("비밀번호 확인이 일치하지 않습니다.");
      return;
    }

    setIsLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          company_name: companyName,
          verification_status: "pending",
        },
      },
    });

    if (error) {
      setMessage("회원가입 실패: " + error.message);
      setIsLoading(false);
      return;
    }

    setMessage("회원가입이 완료되었습니다. 역할 설정 화면으로 이동합니다.");
    setIsLoading(false);
    setTimeout(() => router.push("/onboarding"), 800);
  };

  return (
    <div className="max-w-md mx-auto mt-20 p-6 bg-white rounded-xl shadow-md border border-gray-200">
      <h1 className="text-3xl font-bold text-center text-gray-800 mb-2">회원가입</h1>
      <p className="text-center text-sm text-gray-500 mb-8">
        이름/업체명 입력 후 가입하고, 다음 화면에서 역할을 설정하세요.
      </p>

      <form onSubmit={handleSignUp} className="flex flex-col gap-5">
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
          <label className="block text-sm font-medium text-gray-700 mb-2">업체명(선택)</label>
          <input
            type="text"
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="업체 회원인 경우 입력"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">이메일</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="you@example.com"
            required
          />
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
          본인인증/사업자 인증은 다음 단계에서 추가 예정입니다.
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
