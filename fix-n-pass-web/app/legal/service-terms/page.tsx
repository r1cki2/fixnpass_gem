import Link from "next/link";
import type { Metadata } from "next";
import { serviceTermsSections } from "@/lib/agreementsContent";

export const metadata: Metadata = {
  title: "서비스 이용약관 | Fix&Pass",
  description: "픽스앤패스 서비스 이용 약관",
};

export default function ServiceTermsPage() {
  return (
    <div className="max-w-3xl mx-auto py-8">
      <Link href="/signup" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
        ← 회원가입으로
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">픽스앤패스 서비스 이용 약관</h1>
      <p className="text-sm text-gray-500 mb-8">본 문서는 서비스 내 동의 화면의 상세보기용입니다.</p>
      <div className="space-y-8 text-sm text-gray-800 leading-relaxed">
        {serviceTermsSections.map((sec, idx) => (
          <section key={`${idx}-${sec.title}`}>
            <h2 className="text-base font-semibold text-gray-900 mb-3 border-b border-gray-200 pb-2">
              {sec.title}
            </h2>
            {sec.paragraphs?.map((p, i) => (
              <p key={i} className="mb-3 whitespace-pre-wrap">
                {p}
              </p>
            ))}
            {sec.items && (
              <ol className="list-decimal pl-5 space-y-2">
                {sec.items.map((item, i) => (
                  <li key={i} className="whitespace-pre-wrap">
                    {item}
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
