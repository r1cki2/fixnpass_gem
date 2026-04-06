import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from "next/link"; // 페이지 이동을 위한 Next.js 컴포넌트

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Fix & Pass",
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
        {/* 상단 네비게이션 바 (GNB) */}
        <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
          <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
            {/* 로고 영역 */}
            <Link href="/" className="font-bold text-2xl text-blue-600 tracking-tight">
              Fix & Pass
            </Link>
            
            {/* 메뉴 영역 */}
            <nav className="flex gap-6 text-sm font-semibold text-gray-600">
              <Link href="/my-requests" className="hover:text-blue-600 transition-colors">
                내 요청 내역
              </Link>
              <Link href="/contractor/market" className="hover:text-blue-600 transition-colors">
                수리 마켓 (업체용)
              </Link>
            </nav>
          </div>
        </header>

        {/* 메인 컨텐츠 영역 */}
        <main className="max-w-5xl mx-auto p-4 min-h-screen">
          {children}
        </main>
      </body>
    </html>
  );
}