'use client';

import { useEffect, useState } from 'react';
import { Clock, ChevronRight, Building2, FileText, AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { submitPendingQuoteRequest } from '@/lib/pendingQuote';

export default function MyRequestsPage() {
  const [requests, setRequests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchRequests = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user?.id) {
          setRequests([]);
          setLoading(false);
          return;
        }
        const { data: profile } = await supabase
          .from("profiles")
          .select("role")
          .eq("id", user.id)
          .single();
        if (profile?.role === "contractor") {
          alert("수리업체 계정은 내 요청 내역에 접근할 수 없습니다.");
          window.location.href = "/contractor/market";
          return;
        }
        const pending = await submitPendingQuoteRequest(user.id);
        if (pending.ok) {
          // 자동 완료 알림 팝업은 제거 (요청사항)
        }
        const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
        const res = await fetch(`${baseUrl}/api/my-requests?requester_id=${user.id}`);
        
        if (!res.ok) throw new Error('서버에서 데이터를 불러오지 못했습니다.');
        
        const result = await res.json();
        if (result.data) setRequests(result.data);
      } catch (error) {
        console.error('Fetch error:', error);
      } finally {
        setLoading(false);
      }
    };
    
    fetchRequests();
  }, []);

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      <div className="flex flex-col items-center gap-4">
        <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
        <p className="text-slate-500 font-bold">내역을 불러오는 중...</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-slate-50 p-6 font-sans">
      <div className="max-w-3xl mx-auto pt-10">
        <header className="mb-10">
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-3xl font-extrabold text-slate-900">내 수리 요청 내역</h1>
            <span className="bg-slate-200 text-slate-600 px-2 py-0.5 rounded text-xs font-bold">Beta</span>
          </div>
          <p className="text-slate-500 font-medium">진행 중인 견적 요청 현황입니다.</p>
        </header>

        <div className="space-y-5">
          {requests.length === 0 ? (
            <div className="bg-white p-12 rounded-3xl text-center border border-dashed border-slate-300 shadow-sm">
              <FileText className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500 font-medium mb-4">아직 요청하신 내역이 없습니다.</p>
              <Link href="/" className="inline-block bg-blue-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-blue-700 transition-colors shadow-lg shadow-blue-100">
                첫 견적 요청하러 가기
              </Link>
            </div>
          ) : (
            requests.map((req) => {
              // 정석대로 정확한 PK(int8)를 사용합니다.
              const pk = req.repair_request_id;
              
              return (
                <div key={pk} className="bg-white p-6 rounded-3xl shadow-sm border border-slate-200 hover:shadow-md transition-all group">
                  <div className="flex justify-between items-center mb-4">
                    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-[11px] font-black tracking-wide uppercase
                      ${req.status === 'requested' ? 'bg-blue-100 text-blue-700' : 
                        req.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-green-100 text-green-700'}`}>
                      {req.status === 'pending' && <AlertTriangle className="w-3 h-3" />}
                      <Clock className="w-3 h-3" />
                      {req.status === 'requested' ? '견적 대기 중' : 
                       req.status === 'pending' ? '작성 중(임시저장)' : req.status}
                    </div>
                    <span className="text-sm font-medium text-slate-400">
                      {new Date(req.created_at).toLocaleDateString('ko-KR')}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 mb-6">
                    <div className="w-14 h-14 bg-slate-50 border border-slate-100 rounded-2xl flex items-center justify-center text-slate-400 shrink-0 group-hover:bg-blue-50 group-hover:border-blue-100 transition-colors">
                      <Building2 className="w-7 h-7 group-hover:text-blue-500" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-extrabold text-lg text-slate-900 leading-none">
                          {req.building_name || '건물명 미확인'}
                        </h3>
                        {req.parking_type && req.parking_type !== '기종 확인 불가' && (
                          <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-[10px] font-bold rounded-md border border-indigo-100">
                            {req.parking_type}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-slate-500 font-medium">{req.region_summary}</p>
                    </div>
                  </div>

                  <div className="border-t border-slate-100 pt-4 flex justify-between items-center">
                    <div className="text-sm text-slate-600 font-medium">
                      선택 항목: <span className="font-black text-blue-600">{req.selected_items?.length || 0}건</span>
                    </div>
                    {/* URL 이동도 깔끔하게 숫자 ID로 넘어갑니다. */}
                    <Link href={`/my-requests/${pk}`} className="flex items-center gap-1 text-sm font-bold text-slate-400 group-hover:text-blue-600 transition-all">
                      내역 확인 <ChevronRight className="w-5 h-5 transition-transform group-hover:translate-x-1" />
                    </Link>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}