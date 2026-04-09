'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, DollarSign, Send, Loader2, Info, AlertTriangle, Lock } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export default function ContractorBidPage() {
  const params = useParams();
  const router = useRouter();
  const requestId = params.id;

  const [req, setReq] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [hasBid, setHasBid] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [isMatched, setIsMatched] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  useEffect(() => {
    const fetchDetail = async () => {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user?.id) {
          router.push('/login');
          return;
        }
        setPartnerId(user.id);
        const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
        const res = await fetch(`${baseUrl}/api/contractor/market/${requestId}?partner_id=${user.id}`);
        const result = await res.json();
        
        if (result.data) {
          setReq(result.data);
          const matched = ['matched', 'repairing', 'completed'].includes(result.data.status);
          setIsMatched(matched);

          if (result.data.my_bid) {
            setHasBid(true);
            setAmount(result.data.my_bid.bid_amount.toString());
            // 수정 횟수가 1 이상이거나 매칭된 경우 수정 불가
            if (result.data.my_bid.edit_count >= 1 || matched) {
              setCanEdit(false);
            }
          }
        }
      } catch (error) {
        console.error(error);
      }
    };
    fetchDetail();
  }, [requestId, router]);

  const handleSubmitBid = async () => {
    // 팝업 안내 로직 추가
    if (hasBid && !canEdit) {
      alert('견적액 수정은 1회까지만 가능합니다.');
      return;
    }
    if (!partnerId) {
      alert('로그인이 필요합니다.');
      return;
    }
    
    if (!amount) return alert('견적 금액을 입력해주세요.');
    
    setIsSubmitting(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/contractor/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repair_request_id: Number(requestId),
          partner_id: partnerId,
          bid_amount: Number(amount)
        })
      });

      const result = await res.json();
      if (res.ok) {
        alert(hasBid ? '견적 수정이 완료되었습니다.' : '견적 제출이 완료되었습니다.');
        router.push('/contractor/market');
      } else {
        alert(result.detail || '처리 중 오류가 발생했습니다.');
      }
    } catch (error) {
      alert('서버 통신 오류가 발생했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const openMaskedPdf = async () => {
    if (!partnerId) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const res = await fetch(
      `${baseUrl}/api/requests/${requestId}/pdf?viewer=contractor&user_id=${partnerId}`
    );
    const json = await res.json();
    if (!res.ok) {
      alert(json.detail || '마스킹 PDF를 열 수 없습니다.');
      return;
    }
    window.open(json.url, '_blank');
  };

  if (!req) return <div className="min-h-screen bg-slate-50 flex items-center justify-center">로딩 중...</div>;

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 pb-20 font-sans">
      <div className="max-w-3xl mx-auto pt-8">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-slate-400 hover:text-slate-900 mb-8 font-bold">
          <ArrowLeft className="w-5 h-5" /> 돌아가기
        </button>

        <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm mb-8">
          <div className="flex justify-between items-start mb-10">
            <div>
              <h1 className="text-3xl font-black text-slate-900 mb-2">{req.building_name}</h1>
              <p className="text-slate-500 font-medium">{req.region_summary} · {req.parking_type}</p>
            </div>
            {isMatched ? (
              <span className="bg-indigo-100 text-indigo-700 px-4 py-2 rounded-2xl text-sm font-black flex items-center gap-2">
                <Lock className="w-4 h-4" /> 매칭 완료
              </span>
            ) : hasBid && (
              <span className={`px-4 py-2 rounded-2xl text-sm font-black flex items-center gap-2 ${canEdit ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                {canEdit ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
                {canEdit ? '수정 가능 (1회)' : '수정 횟수 초과'}
              </span>
            )}
          </div>

          <div className="space-y-4 mb-10">
            <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">수리 요청 항목</h3>
            {req.selected_items?.map((item: string, i: number) => (
              <div key={i} className="flex items-start gap-4 bg-slate-50 p-5 rounded-2xl border border-slate-100">
                <CheckCircle2 className="w-6 h-6 text-blue-600 shrink-0" />
                <span className="text-slate-700 font-bold">{item}</span>
              </div>
            ))}
          </div>

          <button
            onClick={openMaskedPdf}
            className="mb-8 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold py-3 rounded-xl"
          >
            업체용 마스킹 PDF 보기
          </button>

          <div className="border-t border-slate-100 pt-10">
            <div className={`rounded-[2rem] p-8 text-white shadow-xl ${canEdit ? 'bg-blue-600 shadow-blue-100' : 'bg-slate-400 shadow-none'}`}>
              <div className="flex items-center gap-3 mb-6">
                <DollarSign className="w-6 h-6" />
                <h3 className="text-xl font-black">{hasBid ? (canEdit ? '견적액 수정' : '수정 불가') : '견적액 입력'}</h3>
              </div>
              
              <div className="space-y-6">
                <input 
                  type="number" 
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  disabled={!canEdit}
                  placeholder="금액을 입력하세요"
                  className={`w-full border-none rounded-2xl p-5 text-white font-black text-3xl outline-none transition-all ${canEdit ? 'bg-blue-700 focus:ring-4 focus:ring-blue-400/50' : 'bg-slate-500 cursor-not-allowed'}`}
                />
                
                <div className={`${canEdit ? 'bg-blue-700/50' : 'bg-slate-500/50'} p-4 rounded-xl flex items-start gap-3`}>
                  <Info className="w-5 h-5 text-white opacity-80 shrink-0 mt-0.5" />
                  <p className="text-xs text-white opacity-90 leading-relaxed font-medium">
                    {isMatched ? "이미 매칭된 요청은 금액을 수정할 수 없습니다." : 
                     "견적액은 제출 후 의뢰인 선택 전까지 1회만 수정 가능합니다."}
                  </p>
                </div>

                <button 
                  onClick={handleSubmitBid}
                  className={`w-full font-black py-5 rounded-2xl transition-all flex items-center justify-center gap-2 text-xl shadow-lg active:scale-95 ${canEdit ? 'bg-white text-blue-600 hover:bg-slate-50' : 'bg-slate-300 text-slate-500 cursor-not-allowed'}`}
                >
                  {isSubmitting ? <Loader2 className="w-6 h-6 animate-spin" /> : <><Send className="w-5 h-5" /> {hasBid ? '견적 수정하기' : '견적 보내기'}</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}