"use client";

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { supabase } from "@/lib/supabase";

function PartnerDetailInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const partnerId = params.id as string;
  const requestId = searchParams.get("request_id");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const run = async () => {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      let url = `${baseUrl}/api/partner/${partnerId}`;
      if (requestId) url += `?request_id=${encodeURIComponent(requestId)}`;

      const headers: HeadersInit = {};
      if (requestId) {
        const { data: sess } = await supabase.auth.getSession();
        const t = sess.session?.access_token;
        if (t) headers.Authorization = `Bearer ${t}`;
      }

      const res = await fetch(url, { headers });
      const json = await res.json();
      if (!res.ok) {
        alert(json.detail || "업체 정보를 불러오지 못했습니다.");
        router.back();
        return;
      }
      setData(json.data);
      setLoading(false);
    };
    run();
  }, [partnerId, requestId, router]);

  if (loading) return <div className="min-h-screen flex items-center justify-center">로딩 중...</div>;

  const masked = Boolean(data.display_company_masked);
  const locationValue = masked
    ? "비공개"
    : data.business_location || "정보 미등록";

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button onClick={() => router.back()} className="text-sm text-slate-500 hover:text-slate-700 mb-6">
        ← 돌아가기
      </button>
      <div className="bg-white border rounded-2xl p-6 space-y-4 overflow-hidden">
        <h1 className="text-2xl font-black">{data.company_name || data.name || "업체명 미등록"}</h1>
        <p className="text-sm text-slate-500">
          리뷰 평점: <span className="font-bold text-amber-600">{data.avg_rating}</span> ({data.review_count}건)
        </p>
        <div className="grid md:grid-cols-2 gap-3 text-sm min-w-0">
          <InfoItem label="소재지" value={locationValue} />
          <InfoItem
            label="관심 지역"
            value={
              Array.isArray(data.service_regions) && data.service_regions.length > 0
                ? data.service_regions.join(", ")
                : "정보 미등록"
            }
          />
          <InfoItem label="업력" value={data.years_experience ? `${data.years_experience}년` : "정보 미등록"} />
          <InfoItem label="직원수" value={data.employee_count ? `${data.employee_count}명` : "정보 미등록"} />
          <InfoItem label="휴대폰 번호" value={data.phone_number || "비공개"} />
          <InfoItem label="사무실 전화번호" value={data.office_phone_number || "비공개"} />
        </div>
        <p className="text-[11px] leading-relaxed text-slate-500 break-words w-full min-w-0">
          업력 및 직원수는 보수 업체가 기입한 사항으로 참고를 위해 제공드리며, 당사는 사실과 다름으로 생기는 문제, 불이익에
          대해 보증하거나 책임지지 않습니다.
        </p>
      </div>
    </div>
  );
}

export default function PartnerDetailPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-slate-500">로딩 중...</div>}>
      <PartnerDetailInner />
    </Suspense>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3 min-w-0 overflow-hidden">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="font-semibold text-slate-700 break-words">{value}</p>
    </div>
  );
}
