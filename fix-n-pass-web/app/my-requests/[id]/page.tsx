'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Building2, Clock, CheckSquare, ArrowLeft, Receipt, Star, Phone, CheckCircle2, AlertCircle } from 'lucide-react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const requestId = params.id;
  
  const [reqData, setReqData] = useState<any>(null);
  const [bids, setBids] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) {
        setLoading(false);
        return;
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();
      if (profile?.role === "contractor") {
        alert("수리업체 계정은 내 요청 상세에 접근할 수 없습니다.");
        window.location.href = "/contractor/market";
        return;
      }
      setUserId(user.id);
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const [reqRes, bidRes] = await Promise.all([
        fetch(`${baseUrl}/api/my-requests/${requestId}?requester_id=${user.id}`),
        fetch(`${baseUrl}/api/my-requests/${requestId}/bids?requester_id=${user.id}`)
      ]);
      
      const reqJson = await reqRes.json();
      const bidJson = await bidRes.json();
      
      setReqData(reqJson.data);
      setBids(bidJson.data);
      setSelectedIds(reqJson.data.selected_bid_ids || []);
      setLoading(false);
    };
    fetchData();
  }, [requestId]);

  const toggleSelect = (bidId: number) => {
    setSelectedIds(prev => {
      if (prev.includes(bidId)) return prev.filter(id => id !== bidId);
      if (prev.length >= 2) {
        alert("최대 2개 업체까지만 선택 가능합니다.");
        return prev;
      }
      return [...prev, bidId];
    });
  };

  const handleMatch = async () => {
    if (!userId) return alert('로그인이 필요합니다.');
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const res = await fetch(`${baseUrl}/api/match-partners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repair_request_id: Number(requestId),
        requester_id: userId,
        selected_bid_ids: selectedIds
      })
    });
    
    if (res.ok) {
      alert("선택한 업체와 매칭되었습니다. 이제 연락처를 확인하실 수 있습니다.");
      window.location.reload();
    }
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center">로딩 중...</div>;

  return (
    <div className="min-h-screen bg-slate-50 p-6 pb-20">
      <div className="max-w-4xl mx-auto pt-8">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-slate-400 hover:text-slate-900 mb-8 font-bold transition-colors">
          <ArrowLeft className="w-5 h-5" /> 내 요청 목록
        </button>

        {/* 상단 기본 정보 섹션 (기존과 동일하되 디자인 강화) */}
        <div className="bg-white border rounded-[2.5rem] p-10 shadow-sm mb-10">
          <div className="flex justify-between items-start mb-8 border-b pb-8">
            <div>
              <h1 className="text-3xl font-black text-slate-900 mb-2">{reqData.building_name}</h1>
              <p className="text-slate-500 font-medium text-lg">{reqData.region_summary}</p>
            </div>
            <div className={`px-4 py-2 rounded-2xl text-sm font-black ${reqData.status === 'matched' ? 'bg-green-100 text-green-700' : 'bg-blue-100 text-blue-700'}`}>
              {reqData.status === 'matched' ? '매칭 완료' : '견적 수신 중'}
            </div>
          </div>

          <div className="grid gap-4">
             <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">내가 선택한 수리 항목</h3>
             {reqData.selected_items?.map((item: string, i: number) => (
                <div key={i} className="flex items-center gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-100 font-bold text-slate-700">
                  <CheckSquare className="w-5 h-5 text-blue-600" /> {item}
                </div>
             ))}
          </div>
        </div>

        {/* 베타 테스트 알림 */}
        <div className="bg-blue-600 text-white p-6 rounded-[2rem] mb-10 flex items-center justify-between shadow-xl shadow-blue-100">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500 rounded-2xl flex items-center justify-center">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              <p className="font-black text-lg text-white">베타 서비스 기간 무료!</p>
              <p className="text-blue-100 text-sm font-medium">지금은 중개수수료 없이 바로 파트너 연락처가 공개됩니다.</p>
            </div>
          </div>
        </div>

        {/* 도착한 견적 리스트 */}
        <h2 className="text-2xl font-black text-slate-900 mb-6 flex items-center gap-3">
           <Receipt className="w-6 h-6 text-blue-600" /> 도착한 견적 내역
        </h2>

        <div className="grid gap-6">
          {bids.length === 0 ? (
            <div className="bg-white border border-dashed p-20 rounded-[2.5rem] text-center text-slate-400 font-bold">
              아직 도착한 견적이 없습니다.
            </div>
          ) : (
            bids.map((bid) => (
              <div key={bid.bid_id} className={`bg-white border-2 p-8 rounded-[2.5rem] transition-all relative ${selectedIds.includes(bid.bid_id) ? 'border-blue-600 shadow-blue-50' : 'border-white shadow-sm'}`}>
                <div className="flex justify-between items-start mb-6">
                  <div>
                    <div className="flex items-center gap-3 mb-2">
                      <h4 className="text-xl font-black text-slate-900">{bid.partner_name}</h4>
                      <Link href={`/partner/${bid.partner_id}`} className="text-xs font-bold text-blue-600 hover:underline">업체 정보 보기 &gt;</Link>
                    </div>
                    <div className="flex items-center gap-4 text-sm font-bold text-slate-500">
                      <span className="flex items-center gap-1 text-amber-500"><Star className="w-4 h-4 fill-current" /> {bid.avg_rating} ({bid.review_count})</span>
                      {bid.is_selected && <span className="flex items-center gap-1 text-green-600"><Phone className="w-4 h-4" /> {bid.partner_phone}</span>}
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400 font-black mb-1 uppercase">제시 금액</p>
                    <p className="text-2xl font-black text-blue-600">{bid.bid_amount.toLocaleString()}원</p>
                  </div>
                </div>

                {reqData.status !== 'matched' && (
                  <button 
                    onClick={() => toggleSelect(bid.bid_id)}
                    className={`w-full py-4 rounded-2xl font-black transition-all flex items-center justify-center gap-2 ${selectedIds.includes(bid.bid_id) ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
                  >
                    {selectedIds.includes(bid.bid_id) ? <><CheckCircle2 className="w-5 h-5" /> 선택됨</> : '이 업체 선택하기'}
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {/* 최종 매칭 버튼 (하단 고정 느낌) */}
        {reqData.status !== 'matched' && selectedIds.length > 0 && (
          <div className="mt-10 animate-in fade-in slide-in-from-bottom-4">
             <button onClick={handleMatch} className="w-full bg-slate-900 text-white py-6 rounded-[2rem] font-black text-xl shadow-2xl hover:bg-slate-800 transition-all flex items-center justify-center gap-3">
               선택한 {selectedIds.length}개 업체와 최종 매칭하기 <Receipt className="w-6 h-6" />
             </button>
             <p className="text-center text-slate-400 text-sm mt-4 font-medium">최종 매칭 후에는 파트너와 전화 상담이 가능합니다.</p>
          </div>
        )}
      </div>
    </div>
  );
}