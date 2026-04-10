import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link";
import AuthNav from "@/components/AuthNav"; // 방금 만든 인증 네비게이션 불러오기

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Fix&Pass (픽스앤패스)",
  description: "기계식 주차장 안전검사 및 수리 매칭 플랫폼",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className={`${inter.className} bg-gray-50 text-gray-900`}>
        <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
            {/* 좌측 로고 및 메인 메뉴 */}
            <div className="flex items-center gap-8">
              <Link href="/" className="font-bold text-2xl text-blue-600 tracking-tight">
                Fix&Pass
              </Link>
              <nav className="hidden md:flex gap-6 text-sm font-semibold text-gray-600">
                <Link href="/my-requests" className="hover:text-blue-600 transition-colors">
                  내 요청 내역
                </Link>
                <Link href="/my-page" className="hover:text-blue-600 transition-colors">
                  마이페이지
                </Link>
                <Link href="/contractor/market" className="hover:text-blue-600 transition-colors">
                  수리 마켓 (업체용)
                </Link>
              </nav>
            </div>
            
            {/* 우측 로그인/로그아웃 상태 표시 영역 */}
            <AuthNav />

          </div>
        </header>

        <main className="max-w-5xl mx-auto p-4 min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}