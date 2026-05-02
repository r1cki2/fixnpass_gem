'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, CheckCircle2, DollarSign, Send, Loader2, Info, AlertTriangle, Lock, Phone, Building2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';

export default function ContractorBidPage() {
  const params = useParams();
  const router = useRouter();
  const requestId = params.id;

  const [req, setReq] = useState<any>(null);
  const [amount, setAmount] = useState('');
  const toDigits = (v: string) => v.replace(/[^0-9]/g, "");
  const formatWon = (v: string) => {
    const d = toDigits(v);
    if (!d) return "";
    return Number(d).toLocaleString("ko-KR");
  };
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  const [hasBid, setHasBid] = useState(false);
  const [canEdit, setCanEdit] = useState(true);
  const [isMatched, setIsMatched] = useState(false);
  const [partnerId, setPartnerId] = useState<string | null>(null);

  const [progVisit, setProgVisit] = useState("");
  const [progFinal, setProgFinal] = useState("");
  const [progVar, setProgVar] = useState("");
  const [progExtra, setProgExtra] = useState("");
  const [savingProgress, setSavingProgress] = useState(false);

  const loadDetail = useCallback(async () => {
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
        if (matched) setCanEdit(false);

        if (result.data.my_bid) {
          setHasBid(true);
          setAmount(result.data.my_bid.bid_amount.toString());
          if (result.data.my_bid.edit_count >= 1 || matched) {
            setCanEdit(false);
          }
        }
      }
    } catch (error) {
      console.error(error);
    }
  }, [requestId, router]);

  useEffect(() => {
    loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    const b = req?.my_bid;
    if (!b) return;
    setProgVisit(b.site_visit_date ? String(b.site_visit_date).slice(0, 10) : "");
    setProgFinal(b.final_bid_amount != null ? String(b.final_bid_amount) : "");
    setProgVar(b.variance_reason || "");
    setProgExtra(b.contractor_extra_note || "");
  }, [
    req?.my_bid?.bid_id,
    req?.my_bid?.site_visit_date,
    req?.my_bid?.final_bid_amount,
    req?.my_bid?.variance_reason,
    req?.my_bid?.contractor_extra_note,
  ]);

  const saveFinalQuote = async () => {
    if (!partnerId || !req?.my_bid?.bid_id) return;
    const vd = progVisit.trim();
    const digits = toDigits(progFinal);
    const vr = progVar.trim();
    if (!vd) return alert("현장 내방 일자를 입력해주세요.");
    if (!digits) return alert("최종견적액을 입력해주세요.");
    if (vr.length < 2) return alert("최초 견적 대비 변동 사유를 입력해주세요.");
    setSavingProgress(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/contractor/bids/final-quote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bid_id: req.my_bid.bid_id,
          partner_id: partnerId,
          site_visit_date: vd,
          final_bid_amount: Number(digits),
          variance_reason: vr,
          contractor_extra_note: progExtra.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.detail || "저장에 실패했습니다.");
        return;
      }
      alert("저장되었습니다. 플랫폼에 최종 견적 정보가 반영되었습니다.");
      await loadDetail();
    } finally {
      setSavingProgress(false);
    }
  };

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
    
    if (!toDigits(amount)) return alert('견적 금액을 입력해주세요.');
    
    setIsSubmitting(true);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/contractor/bid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repair_request_id: Number(requestId),
          partner_id: partnerId,
          bid_amount: Number(toDigits(amount))
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
  const parkingInfo = req?.parsed_data?.site_info?.parking || {};
  const manufacturer = parkingInfo?.manufacturer || "-";
  const elevatorRaw = parkingInfo?.elevator_count ?? "-";
  const elevatorDisplay = formatElevatorDisplay(elevatorRaw);

  const deadlineLabel = req.quote_deadline_at
    ? new Date(req.quote_deadline_at).toLocaleDateString("ko-KR")
    : "-";
  const myBidAt = req.my_bid?.created_at
    ? new Date(req.my_bid.created_at).toLocaleDateString("ko-KR")
    : hasBid
      ? "-"
      : "미제출";

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-6 pb-20 font-sans">
      <div className="max-w-3xl mx-auto pt-8">
        <button onClick={() => router.back()} className="flex items-center gap-2 text-slate-400 hover:text-slate-900 mb-8 font-bold">
          <ArrowLeft className="w-5 h-5" /> 돌아가기
        </button>

        <p className="text-sm text-slate-600 mb-4 leading-relaxed">
          제출하신 견적이 선택될 경우 연락처, 주소 등 상세 정보가 공개됩니다.
        </p>

        <div className="bg-white border border-slate-200 rounded-[2.5rem] p-10 shadow-sm mb-8">
          <div className="flex justify-between items-start mb-10">
            <div className="min-w-0 flex-1">
              <h1 className="text-3xl font-black text-slate-900 mb-4">{req.site_alias || "비공개 현장"}</h1>
              <div className="rounded-2xl border-2 border-blue-100 bg-gradient-to-br from-blue-50/90 to-slate-50 px-5 py-4 mb-6">
                <p className="text-[11px] font-black text-blue-600 uppercase tracking-widest mb-1">지역 (시·군·구)</p>
                <p className="text-xl font-black text-slate-900 leading-snug">{req.region_summary || "—"}</p>
                <p className="text-[11px] font-black text-indigo-600 uppercase tracking-widest mt-4 mb-1">승강기 종류·방식</p>
                <p className="text-lg font-bold text-indigo-950">{req.parking_type || "—"}</p>
              </div>
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-3">
                <DetailMetaChip label="제작사" value={manufacturer} wide />
                <DetailMetaChip label="승강기 대수·기" value={elevatorDisplay} wide />
                <DetailMetaChip label="요청 상태" value={req.request_stage_kr || req.status} />
                <DetailMetaChip label="견적 마감일" value={deadlineLabel} />
                <DetailMetaChip label="내 견적 등록일" value={myBidAt} />
              </div>
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

          {req.show_requester_contact && req.requester_contact && (
            <div className="mb-10 space-y-4">
              <div className="rounded-2xl border-2 border-emerald-200 bg-emerald-50/80 p-6">
                <h3 className="text-sm font-black text-emerald-800 uppercase tracking-widest mb-3">수리 의뢰인 연락처·현장</h3>
                <div className="grid sm:grid-cols-2 gap-3 text-sm">
                  <div className="flex items-start gap-2">
                    <Phone className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-bold text-emerald-700">휴대폰</p>
                      <p className="font-black text-slate-900">{req.requester_contact.phone_number}</p>
                    </div>
                  </div>
                  {req.requester_contact.office_phone_number ? (
                    <div className="flex items-start gap-2">
                      <Phone className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                      <div>
                        <p className="text-[11px] font-bold text-emerald-700">사무실</p>
                        <p className="font-black text-slate-900">{req.requester_contact.office_phone_number}</p>
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-start gap-2 sm:col-span-2">
                    <Building2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-[11px] font-bold text-emerald-700">건물명 · 상세주소</p>
                      <p className="font-bold text-slate-900">{req.requester_contact.building_name}</p>
                      <p className="text-slate-700 mt-1">{req.requester_contact.region_summary} {req.requester_contact.address_detail}</p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-900 leading-relaxed">
                수리 요청인께 연락하시어 내방 일정을 잡으시고, 내방 및 검토 후 최종견적액을 저희에게도 알려주세요.
              </div>
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-6 space-y-4">
                <h4 className="font-black text-slate-900">최종 견적 · 현장 내방 정보 등록</h4>
                <label className="block text-xs font-bold text-slate-600">최종견적액 산정 위한 현장 내방 일자 (필수)</label>
                <input
                  type="date"
                  value={progVisit}
                  onChange={(e) => setProgVisit(e.target.value)}
                  className="w-full border rounded-xl px-4 py-3 text-sm font-semibold"
                />
                <label className="block text-xs font-bold text-slate-600">최종견적액 (필수)</label>
                <input
                  type="text"
                  inputMode="numeric"
                  value={formatWon(progFinal)}
                  onChange={(e) => setProgFinal(formatWon(e.target.value))}
                  placeholder="금액 (원)"
                  className="w-full border rounded-xl px-4 py-3 text-lg font-black"
                />
                <label className="block text-xs font-bold text-slate-600">최초견적액 대비 최종견적액 변동 사유 (필수)</label>
                <textarea
                  value={progVar}
                  onChange={(e) => setProgVar(e.target.value)}
                  rows={3}
                  className="w-full border rounded-xl px-4 py-3 text-sm"
                  placeholder="변동 사유를 입력해주세요."
                />
                <label className="block text-xs font-bold text-slate-600">현장 내방 후기 및 기타 의견 (선택)</label>
                <textarea
                  value={progExtra}
                  onChange={(e) => setProgExtra(e.target.value)}
                  rows={2}
                  className="w-full border rounded-xl px-4 py-3 text-sm"
                />
                <button
                  type="button"
                  onClick={saveFinalQuote}
                  disabled={savingProgress}
                  className="w-full py-4 rounded-2xl bg-slate-900 text-white font-black disabled:bg-slate-400"
                >
                  {savingProgress ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "최종 정보 저장"}
                </button>
              </div>
            </div>
          )}

          <div className="space-y-6 mb-10">
            <h3 className="text-sm font-black text-slate-400 uppercase tracking-widest">수리 요청 항목</h3>
            {(req.selected_items_mandatory?.length > 0 || req.selected_items_optional?.length > 0) ? (
              <>
                {req.selected_items_mandatory?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-rose-600 uppercase tracking-wider">부적합 항목</p>
                    {req.selected_items_mandatory.map((item: string, i: number) => (
                      <div key={`m-${i}`} className="flex items-start gap-4 bg-rose-50/80 p-5 rounded-2xl border border-rose-100">
                        <CheckCircle2 className="w-6 h-6 text-rose-600 shrink-0" />
                        <span className="text-slate-800 font-bold">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
                {req.selected_items_optional?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-blue-600 uppercase tracking-wider">권고 항목</p>
                    {req.selected_items_optional.map((item: string, i: number) => (
                      <div key={`o-${i}`} className="flex items-start gap-4 bg-blue-50/80 p-5 rounded-2xl border border-blue-100">
                        <CheckCircle2 className="w-6 h-6 text-blue-600 shrink-0" />
                        <span className="text-slate-800 font-bold">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
                {(req.selected_items_unspecified?.length > 0) && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-slate-500 uppercase tracking-wider">선택 항목</p>
                    {req.selected_items_unspecified.map((item: string, i: number) => (
                      <div key={`u-${i}`} className="flex items-start gap-4 bg-slate-50 p-5 rounded-2xl border border-slate-100">
                        <CheckCircle2 className="w-6 h-6 text-slate-600 shrink-0" />
                        <span className="text-slate-700 font-bold">{item}</span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              (req.selected_items || []).map((item: string, i: number) => (
                <div key={i} className="flex items-start gap-4 bg-slate-50 p-5 rounded-2xl border border-slate-100">
                  <CheckCircle2 className="w-6 h-6 text-blue-600 shrink-0" />
                  <span className="text-slate-700 font-bold">{item}</span>
                </div>
              ))
            )}
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
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(formatWon(e.target.value))}
                  disabled={!canEdit}
                  placeholder="금액을 입력하세요 (예: 1,200,000)"
                  className={`w-full border-none rounded-2xl p-5 text-white font-black text-3xl outline-none transition-all ${canEdit ? 'bg-blue-700 focus:ring-4 focus:ring-blue-400/50' : 'bg-slate-500 cursor-not-allowed'}`}
                />
                
                <div className={`${canEdit ? 'bg-blue-700/50' : 'bg-slate-500/50'} p-4 rounded-xl flex items-start gap-3`}>
                  <Info className="w-5 h-5 text-white opacity-80 shrink-0 mt-0.5" />
                  <p className="text-xs text-white opacity-90 leading-relaxed font-medium">
                    {isMatched
                      ? "이미 매칭된 요청은 금액을 수정할 수 없습니다."
                      : hasBid
                        ? "견적액은 제출 후 의뢰인 선택 전까지 1회만 수정 가능합니다."
                        : "최초 견적의 유효기간은 견적 요청 마감까지이며, 수정은 선택되기 전까지 1회만 가능합니다."}
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

function formatElevatorDisplay(raw: unknown): string {
  if (raw === null || raw === undefined) return "-";
  const s = String(raw).trim();
  if (!s || s === "-") return "-";
  const da = s.match(/(\d+)\s*대/);
  const gi = s.match(/(\d+)\s*기/);
  if (da && gi) {
    const parts = s.includes(",") ? s : `${da[1]}대, ${gi[1]}기`;
    return parts;
  }
  return s;
}

function DetailMetaChip({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div
      className={`rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 ${
        wide ? "sm:min-h-[5.5rem]" : ""
      }`}
    >
      <p className="text-[11px] text-slate-500 mb-1 font-semibold">{label}</p>
      <p className={`font-semibold text-slate-800 leading-snug ${wide ? "text-base" : "text-sm"}`}>{value || "-"}</p>
    </div>
  );
}