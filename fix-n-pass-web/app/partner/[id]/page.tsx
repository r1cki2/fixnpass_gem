"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";

export default function PartnerDetailPage() {
  const params = useParams();
  const router = useRouter();
  const partnerId = params.id;
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const run = async () => {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/partner/${partnerId}`);
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
  }, [partnerId, router]);

  if (loading) return <div className="min-h-screen flex items-center justify-center">로딩 중...</div>;

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button onClick={() => router.back()} className="text-sm text-slate-500 hover:text-slate-700 mb-6">
        ← 돌아가기
      </button>
      <div className="bg-white border rounded-2xl p-6 space-y-4">
        <h1 className="text-2xl font-black">{data.company_name || data.name || "업체명 미등록"}</h1>
        <p className="text-sm text-slate-500">
          리뷰 평점: <span className="font-bold text-amber-600">{data.avg_rating}</span> ({data.review_count}건)
        </p>
        <div className="grid md:grid-cols-2 gap-3 text-sm">
          <InfoItem label="소재지" value={data.business_location || "정보 미등록"} />
          <InfoItem
            label="관심 지역"
            value={Array.isArray(data.service_regions) && data.service_regions.length > 0 ? data.service_regions.join(", ") : "정보 미등록"}
          />
          <InfoItem label="업력" value={data.years_experience ? `${data.years_experience}년` : "정보 미등록"} />
          <InfoItem label="직원수" value={data.employee_count ? `${data.employee_count}명` : "정보 미등록"} />
          <InfoItem label="휴대폰 번호" value={data.phone_number || "정보 미등록"} />
          <InfoItem label="사무실 전화번호" value={data.office_phone_number || "정보 미등록"} />
        </div>
      </div>
    </div>
  );
}

function InfoItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border p-3">
      <p className="text-xs text-slate-400 mb-1">{label}</p>
      <p className="font-semibold text-slate-700">{value}</p>
    </div>
  );
}
