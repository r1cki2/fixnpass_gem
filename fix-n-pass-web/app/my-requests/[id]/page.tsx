'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Building2, Clock, CheckSquare, ArrowLeft, Receipt, Star, Phone, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import LiabilityDisclaimerModal from '@/components/LiabilityDisclaimerModal';

export default function RequestDetailPage() {
  const params = useParams();
  const router = useRouter();
  const requestId = params.id;
  
  const [reqData, setReqData] = useState<any>(null);
  const [bids, setBids] = useState<any[]>([]);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);
  const [savingBidId, setSavingBidId] = useState<number | null>(null);
  const [requesterFields, setRequesterFields] = useState<
    Record<number, { visit: string; amount: string; variance: string; review: string }>
  >({});
  const [showMatchLiability, setShowMatchLiability] = useState(false);

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
      const bidList = bidJson.data || [];
      setBids(bidList);
      setSelectedIds(reqJson.data.selected_bid_ids || []);
      const rf: Record<number, { visit: string; amount: string; variance: string; review: string }> = {};
      for (const b of bidList) {
        rf[b.bid_id] = {
          visit: b.requester_site_visit_date ? String(b.requester_site_visit_date).slice(0, 10) : "",
          amount:
            b.requester_final_bid_amount != null && b.requester_final_bid_amount !== undefined
              ? String(b.requester_final_bid_amount)
              : "",
          variance: b.requester_variance_note || "",
          review: b.requester_visit_review || "",
        };
      }
      setRequesterFields(rf);
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

  const toDigits = (v: string) => v.replace(/[^0-9]/g, "");
  const formatWon = (v: string) => {
    const d = toDigits(v);
    if (!d) return "";
    return Number(d).toLocaleString("ko-KR");
  };

  const handleMatch = () => {
    if (!userId) return alert('로그인이 필요합니다.');
    setShowMatchLiability(true);
  };

  const executeMatchAfterLiability = async () => {
    if (!userId) return;
    if (selectedIds.length === 1) {
      const ok = confirm(
        "수리 업체의 과도한 현장방문을 방지하고자 최대 2개 업체 까지만 선택 가능하며, 1개만 선택하신 경우 추후 추가 선택은 불가합니다. 신중히 선택해주세요.\n\n선택한 1개 업체로 최종 매칭을 진행할까요?"
      );
      if (!ok) return;
    }
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const res = await fetch(`${baseUrl}/api/match-partners`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repair_request_id: Number(requestId),
        requester_id: userId,
        selected_bid_ids: selectedIds,
        disclaimer_requester_accepted: true,
      })
    });
    
    if (res.ok) {
      alert("선택한 업체와 매칭되었습니다. 이제 연락처를 확인하실 수 있습니다.");
      window.location.reload();
    } else {
      const j = await res.json().catch(() => ({}));
      alert(j.detail || "매칭 처리에 실패했습니다.");
    }
  };

  const saveRequesterFields = async (bidId: number) => {
    if (!userId) return;
    const row = requesterFields[bidId];
    if (!row) return;
    const vd = row.visit.trim();
    const amt = toDigits(row.amount);
    if (!vd) return alert("현장 내방 일자를 입력해주세요.");
    if (!amt) return alert("최종견적액을 입력해주세요.");
    setSavingBidId(bidId);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
      const res = await fetch(`${baseUrl}/api/my-requests/${requestId}/bids/${bidId}/requester-fields`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bid_id: bidId,
          requester_id: userId,
          requester_site_visit_date: vd,
          requester_final_bid_amount: Number(amt),
          requester_variance_note: row.variance.trim() || null,
          requester_visit_review: row.review.trim() || null,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        alert(json.detail || "저장에 실패했습니다.");
        return;
      }
      alert("저장되었습니다.");
      window.location.reload();
    } finally {
      setSavingBidId(null);
    }
  };

  const handleCancelRequest = async () => {
    if (!userId) return alert("로그인이 필요합니다.");
    if (!confirm("견적 요청을 취소하시겠습니까?")) return;
    const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
    const res = await fetch(`${baseUrl}/api/my-requests/${requestId}/cancel?requester_id=${userId}`, {
      method: "POST",
    });
    const json = await res.json();
    if (!res.ok) return alert(json.detail || "취소 실패");
    alert("요청이 취소되었습니다.");
    router.push("/my-requests");
  };

  if (loading) return <div className="min-h-screen flex items-center justify-center">로딩 중...</div>;
  if (!reqData) return <div className="min-h-screen flex items-center justify-center">데이터가 없습니다.</div>;

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
            <div
              className={`px-4 py-2 rounded-2xl text-sm font-black max-w-[min(100%,24rem)] text-right leading-snug ${
                reqData.status === "matched"
                  ? "bg-emerald-100 text-emerald-800"
                  : reqData.status === "bidding"
                    ? "bg-indigo-100 text-indigo-800"
                    : "bg-blue-100 text-blue-700"
              }`}
            >
              {reqData.status_label_kr || reqData.status}
            </div>
          </div>

          <div className="grid gap-5">
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">내가 선택한 수리 항목</h3>
            {(reqData.selected_items_mandatory?.length > 0 || reqData.selected_items_optional?.length > 0) ? (
              <>
                {reqData.selected_items_mandatory?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-rose-600 uppercase tracking-wider">부적합 항목</p>
                    {reqData.selected_items_mandatory.map((item: string, i: number) => (
                      <div key={`m-${i}`} className="flex items-center gap-3 bg-rose-50 p-4 rounded-2xl border border-rose-100 font-bold text-slate-800">
                        <CheckSquare className="w-5 h-5 text-rose-600 shrink-0" /> {item}
                      </div>
                    ))}
                  </div>
                )}
                {reqData.selected_items_optional?.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-blue-600 uppercase tracking-wider">권고 항목</p>
                    {reqData.selected_items_optional.map((item: string, i: number) => (
                      <div key={`o-${i}`} className="flex items-center gap-3 bg-blue-50 p-4 rounded-2xl border border-blue-100 font-bold text-slate-800">
                        <CheckSquare className="w-5 h-5 text-blue-600 shrink-0" /> {item}
                      </div>
                    ))}
                  </div>
                )}
                {(reqData.selected_items_unspecified?.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-black text-slate-500 uppercase tracking-wider">기타 선택 항목</p>
                    {reqData.selected_items_unspecified.map((item: string, i: number) => (
                      <div key={`u-${i}`} className="flex items-center gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-100 font-bold text-slate-700">
                        <CheckSquare className="w-5 h-5 text-slate-600 shrink-0" /> {item}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              reqData.selected_items?.map((item: string, i: number) => (
                <div key={i} className="flex items-center gap-3 bg-slate-50 p-4 rounded-2xl border border-slate-100 font-bold text-slate-700">
                  <CheckSquare className="w-5 h-5 text-blue-600" /> {item}
                </div>
              ))
            )}
          </div>
          {(reqData.status === "requested" || reqData.status === "bidding" || reqData.status === "draft") && (
            <div className="mt-6 space-y-2">
              <button
                onClick={handleCancelRequest}
                disabled={
                  reqData.status !== "draft" &&
                  (reqData.bid_count ?? 0) > 0
                }
                className={`px-4 py-2 rounded-lg border font-semibold text-sm ${
                  reqData.status !== "draft" && (reqData.bid_count ?? 0) > 0
                    ? "bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed"
                    : "bg-rose-50 text-rose-700 border-rose-200"
                }`}
              >
                {reqData.status === "draft" ? "요청 내역 삭제" : "견적 요청 취소"}
              </button>
              {reqData.status !== "draft" && (reqData.bid_count ?? 0) > 0 ? (
                <p className="text-xs text-slate-500">
                  한 건이라도 견적이 제출된 요청은 취소할 수 없습니다.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {/* 안내 */}
        <div className="bg-blue-600 text-white p-6 rounded-[2rem] mb-10 shadow-xl shadow-blue-100">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-blue-500 rounded-2xl flex items-center justify-center shrink-0">
              <AlertCircle className="w-6 h-6" />
            </div>
            <div>
              {reqData.status === "matched" ? (
                <>
                  <p className="font-black text-lg text-white">업체 선정 이후 안내</p>
                  <p className="text-blue-100 text-sm font-medium mt-1 leading-relaxed">
                    수리업체와 연락하시어 내방 일정을 잡으시고, 내방 및 검토 후 최종견적액과 후기를 저희에게도 알려주세요.
                  </p>
                </>
              ) : (
                <>
                  <p className="font-black text-lg text-white">베타 서비스 기간 무료!</p>
                  <p className="text-blue-100 text-sm font-medium">지금은 중개수수료 없이 바로 파트너 연락처가 공개됩니다.</p>
                </>
              )}
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
                    <div className="flex items-center gap-3 mb-2 flex-wrap">
                      <h4 className="text-xl font-black text-slate-900">{bid.partner_name}</h4>
                      <Link
                        href={`/partner/${bid.partner_id}?request_id=${encodeURIComponent(String(requestId))}`}
                        className="text-xs font-bold text-blue-600 hover:underline"
                      >
                        업체 정보 보기 &gt;
                      </Link>
                    </div>
                    <div className="flex items-center gap-4 text-sm font-bold text-slate-500 flex-wrap">
                      <span className="flex items-center gap-1 text-amber-500"><Star className="w-4 h-4 fill-current" /> {bid.avg_rating} ({bid.review_count})</span>
                      <span className="flex items-center gap-1 text-slate-600">
                        <Phone className="w-4 h-4" /> {bid.partner_phone}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xs text-slate-400 font-black mb-1 uppercase">제시 금액</p>
                    <p className="text-2xl font-black text-blue-600">{bid.bid_amount.toLocaleString()}원</p>
                  </div>
                </div>

                {reqData.status !== 'matched' && (
                  <label className={`flex items-center gap-3 w-full cursor-pointer rounded-2xl border-2 px-4 py-4 font-black transition-all ${selectedIds.includes(bid.bid_id) ? 'border-blue-600 bg-blue-50 text-blue-900' : 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100'} ${!selectedIds.includes(bid.bid_id) && selectedIds.length >= 2 ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <input
                      type="checkbox"
                      className="w-5 h-5 rounded border-slate-300 shrink-0"
                      checked={selectedIds.includes(bid.bid_id)}
                      disabled={!selectedIds.includes(bid.bid_id) && selectedIds.length >= 2}
                      onChange={() => toggleSelect(bid.bid_id)}
                    />
                    <span>{selectedIds.includes(bid.bid_id) ? "선정함 (최대 2개 동시 선택)" : "이 업체 선정하기"}</span>
                  </label>
                )}

                {reqData.status === 'matched' && bid.is_selected && (
                  <div className="mt-6 space-y-4 border-t border-slate-100 pt-6">
                    <p className="text-xs text-slate-600 leading-relaxed bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                      내방 일정·최종견적 등은 <span className="font-bold">본인이 현장에서 확인한 내용</span>을 입력해 주세요.
                      업체가 플랫폼에 제출한 최종견적·내방 정보와의 대조는 운영 관리자만 확인합니다.
                    </p>
                    {bid.contractor_final_submitted === false ? (
                      <p className="text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                        해당 업체의 최종 정보 제출이 아직 완료되지 않았을 수 있습니다. 필요 시 업체와 일정을 확인해 주세요.
                      </p>
                    ) : null}
                    <div className="rounded-2xl border border-blue-200 bg-blue-50/50 p-5 space-y-3">
                      <p className="font-black text-slate-900 text-sm">최종 견적·현장 내방 정보 등록</p>
                      {bid.requester_progress_locked_at ? (
                        <p className="text-xs font-semibold text-slate-600 bg-white/80 border border-slate-200 rounded-lg px-3 py-2">
                          제출이 완료되어 이 항목은 더 이상 수정할 수 없습니다.
                        </p>
                      ) : null}
                      <label className="block text-xs font-bold text-slate-600">현장 내방 일자 (필수)</label>
                      <input
                        type="date"
                        min={reqData.min_site_visit_date || undefined}
                        value={requesterFields[bid.bid_id]?.visit ?? ""}
                        onChange={(e) =>
                          setRequesterFields((prev) => {
                            const cur = prev[bid.bid_id] || { visit: "", amount: "", variance: "", review: "" };
                            return { ...prev, [bid.bid_id]: { ...cur, visit: e.target.value } };
                          })
                        }
                        disabled={!!bid.requester_progress_locked_at}
                        className="w-full border rounded-xl px-3 py-2 text-sm font-semibold disabled:bg-slate-100 disabled:text-slate-500"
                      />
                      {reqData.min_site_visit_date ? (
                        <p className="text-[11px] text-slate-500">내방 일자는 업체 선정일({reqData.min_site_visit_date}) 이후만 선택할 수 있습니다.</p>
                      ) : null}
                      <label className="block text-xs font-bold text-slate-600">최종견적액 (필수)</label>
                      <input
                        type="text"
                        inputMode="numeric"
                        value={formatWon(requesterFields[bid.bid_id]?.amount ?? "")}
                        onChange={(e) =>
                          setRequesterFields((prev) => {
                            const cur = prev[bid.bid_id] || { visit: "", amount: "", variance: "", review: "" };
                            return { ...prev, [bid.bid_id]: { ...cur, amount: formatWon(e.target.value) } };
                          })
                        }
                        disabled={!!bid.requester_progress_locked_at}
                        className="w-full border rounded-xl px-3 py-2 text-base font-black disabled:bg-slate-100 disabled:text-slate-500"
                      />
                      <label className="block text-xs font-bold text-slate-600">변동 사유 메모 (선택)</label>
                      <textarea
                        rows={2}
                        value={requesterFields[bid.bid_id]?.variance ?? ""}
                        onChange={(e) =>
                          setRequesterFields((prev) => {
                            const cur = prev[bid.bid_id] || { visit: "", amount: "", variance: "", review: "" };
                            return { ...prev, [bid.bid_id]: { ...cur, variance: e.target.value } };
                          })
                        }
                        disabled={!!bid.requester_progress_locked_at}
                        className="w-full border rounded-xl px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                      />
                      <label className="block text-xs font-bold text-slate-600">업체 현장 내방 후기 (선택)</label>
                      <textarea
                        rows={2}
                        value={requesterFields[bid.bid_id]?.review ?? ""}
                        onChange={(e) =>
                          setRequesterFields((prev) => {
                            const cur = prev[bid.bid_id] || { visit: "", amount: "", variance: "", review: "" };
                            return { ...prev, [bid.bid_id]: { ...cur, review: e.target.value } };
                          })
                        }
                        disabled={!!bid.requester_progress_locked_at}
                        className="w-full border rounded-xl px-3 py-2 text-sm disabled:bg-slate-100 disabled:text-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() => saveRequesterFields(bid.bid_id)}
                        disabled={savingBidId === bid.bid_id || !!bid.requester_progress_locked_at}
                        className="w-full py-3 rounded-xl bg-blue-600 text-white font-black disabled:bg-slate-400"
                      >
                        {savingBidId === bid.bid_id ? <Loader2 className="w-5 h-5 animate-spin mx-auto" /> : "내 확인 정보 저장"}
                      </button>
                    </div>
                  </div>
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
      <LiabilityDisclaimerModal
        open={showMatchLiability}
        variant="requester"
        onClose={() => setShowMatchLiability(false)}
        onAgreed={() => void executeMatchAfterLiability()}
      />
    </div>
  );
}
