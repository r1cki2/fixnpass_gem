"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { supabase } from "@/lib/supabase";
import { useRouter } from "next/navigation";

export default function AuthNav() {
  const [user, setUser] = useState<any>(null);
  const router = useRouter();

  useEffect(() => {
    // 1. 페이지 접속 시 현재 로그인된 세션 정보 가져오기
    const fetchSession = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      setUser(session?.user || null);
    };
    fetchSession();

    // 2. 로그인/로그아웃 등 상태 변화가 생길 때마다 자동으로 화면 업데이트 (이벤트 리스너)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // 로그아웃 처리 함수
  const handleLogout = async () => {
    await supabase.auth.signOut();
    router.push("/"); // 메인 화면으로 이동
  };

  // 로그인 상태일 때 보여줄 UI
  if (user) {
    return (
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-gray-700">{user.email} 님</span>
        <button 
          onClick={handleLogout} 
          className="text-sm font-semibold text-red-500 hover:text-red-700 transition-colors"
        >
          로그아웃
        </button>
      </div>
    );
  }

  // 비로그인 상태일 때 보여줄 UI
  return (
    <Link href="/login" className="text-sm font-semibold text-blue-600 hover:text-blue-800 transition-colors">
      로그인
    </Link>
  );
}