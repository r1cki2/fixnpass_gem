'use client';

import { useEffect, useState } from 'react';
import { Building2, MapPin, Wrench, ChevronRight, Loader2, CheckCircle } from 'lucide-react';
import Link from 'next/link';

export default function ContractorMarketPage() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchMarket = async () => {
      try {
        const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
        const res = await fetch(`${baseUrl}/api/contractor/market`);
        const result = await res.json();
        if (result.data) setRequests(result.data);
      } catch (error) {
        console.error('Market fetch error:', error);
      } finally {
        setLoading(false);
      }
    };
    fetchMarket();
  }, []);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-500 font-bold">
      로딩 중...
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 font-sans">
      <div className="max-w-4xl mx-auto pt-10 pb-20">
        <header className="mb-10">
          <h1 className="text-3xl font-black text-slate-900 mb-2">수리 요청 마켓</h1>
          <p className="text-slate-500 font-medium">파트너님에게 도착한 새로운 수리 일감입니다.</p>
        </header>

        <div className="grid gap-4">
          {requests.map((req) => (
            <Link 
              key={req.repair_request_id} 
              href={`/contractor/market/${req.repair_request_id}`}
              className={`bg-white border p-6 rounded-3xl transition-all flex items-center justify-between group shadow-sm hover:shadow-md ${req.already_bid ? 'border-green-200' : 'border-slate-200'}`}
            >
              <div className="flex items-center gap-5">
                <div className={`w-16 h-16 rounded-2xl flex items-center justify-center shrink-0 transition-colors ${req.already_bid ? 'bg-green-50 text-green-600' : 'bg-slate-50 text-slate-400 group-hover:bg-blue-600 group-hover:text-white'}`}>
                  <Building2 className="w-8 h-8" />
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    {req.already_bid ? (
                      <span className="text-[10px] font-black bg-green-100 text-green-700 px-2 py-0.5 rounded-md flex items-center gap-1">
                        <CheckCircle className="w-3 h-3" /> 견적 신청 완료
                      </span>
                    ) : (
                      <span className="text-[10px] font-black bg-blue-600 text-white px-2 py-0.5 rounded-md uppercase">New</span>
                    )}
                    <h3 className="font-bold text-xl text-slate-900">{req.building_name || '건물명 비공개'}</h3>
                  </div>
                  <div className="flex items-center gap-4 text-sm text-slate-500 font-medium">
                    <span className="flex items-center gap-1.5"><MapPin className="w-4 h-4" /> {req.region_summary}</span>
                    <span className="flex items-center gap-1.5"><Wrench className="w-4 h-4" /> {req.parking_type}</span>
                  </div>
                </div>
              </div>

              <ChevronRight className={`w-6 h-6 transition-all ${req.already_bid ? 'text-green-300' : 'text-slate-300 group-hover:text-blue-600'}`} />
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}