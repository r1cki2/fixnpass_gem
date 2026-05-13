import Link from "next/link";
import type { Metadata } from "next";
import {
  privacyCollectionFooter,
  privacyCollectionIntro,
  privacyCollectionRows,
} from "@/lib/agreementsContent";

export const metadata: Metadata = {
  title: "개인정보 수집 및 이용 동의 | Fix&Pass",
  description: "픽스앤패스 개인정보 수집 및 이용 동의서",
};

export default function PrivacyCollectionPage() {
  return (
    <div className="max-w-3xl mx-auto py-8">
      <Link href="/signup" className="text-sm text-blue-600 hover:underline mb-6 inline-block">
        ← 회원가입으로
      </Link>
      <h1 className="text-2xl font-bold text-gray-900 mb-2">픽스앤패스 개인정보 수집 및 이용 동의서</h1>
      <p className="text-sm text-gray-600 mb-6 whitespace-pre-wrap">{privacyCollectionIntro}</p>
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm text-left">
          <tbody>
            {privacyCollectionRows.map((row) => (
              <tr key={row.label} className="border-b border-gray-100 last:border-0">
                <th className="align-top w-[180px] md:w-[200px] px-4 py-3 bg-gray-50 font-semibold text-gray-800 whitespace-nowrap">
                  {row.label}
                </th>
                <td className="px-4 py-3 text-gray-700 whitespace-pre-wrap">{row.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <section className="mt-8 rounded-lg border border-amber-100 bg-amber-50/80 p-4">
        <h2 className="font-semibold text-gray-900 mb-2">{privacyCollectionFooter.title}</h2>
        <p className="text-sm text-gray-800 leading-relaxed">{privacyCollectionFooter.body}</p>
      </section>
    </div>
  );
}
