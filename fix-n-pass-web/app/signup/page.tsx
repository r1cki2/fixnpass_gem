"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";
import Link from "next/link";

const PHONE_PATTERN = /^010-\d{4}-\d{4}$/;

function formatKoreanMobile(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`;
  return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
}

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [name, setName] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
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
    if (!PHONE_PATTERN.test(phoneNumber)) {
      setMessage("휴대폰 번호는 010-0000-0000 형식(하이픈 포함)으로 입력해주세요.");
      setIsLoading(false);
      return;
    }
    const cleanPhone = phoneNumber.replace(/-/g, "");

    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: {
          name,
          phone_number: cleanPhone,
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
        이름/연락처 입력 후 가입하고, 다음 화면에서 역할과 상세정보를 설정하세요.
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
          <label className="block text-sm font-medium text-gray-700 mb-2">전화번호</label>
          <input
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            value={phoneNumber}
            onChange={(e) => setPhoneNumber(formatKoreanMobile(e.target.value))}
            className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="010-1234-5678"
            maxLength={13}
            required
          />
          <p className="text-xs text-gray-500 mt-1">010으로 시작하는 11자리 번호만 입력됩니다.</p>
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
          베타 버전에서는 형식 검증 후 즉시 사용 가능하며, 본인/허가받은 이해관계인 외 업무 처리에 따른 책임은 당사에 귀속되지 않습니다.
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
