"use client";

import { useState, useEffect } from "react";

const CONTRACTOR_TEXT = `견적 제출 후 고객의 단순 변심으로 인한 매칭 취소가 발생할 수 있습니다. 또한, 최초 견적액 선택 후에도 고객의 단순 변심으로 인한 매칭 취소 가능성이 있으며, 선택이 내방 및 최종 수리 결정을 담보하지 않습니다. 픽스앤패스는 단순 중개 플랫폼으로 이에 대한 직접적인 보상 책임을 지지 않습니다. 특히, 현장 방문 및 견적 산출 과정에서 발생하는 실비(출장비 등)는 당사(픽스앤패스)와 무관하며 당사자 간의 협의에 따릅니다. (견적제출권 소모 시에는 견적제출권 환급 예정)`;

const REQUESTER_TEXT = `선택하신 업체와 직접 연락하여 상세 일정을 확정해 주세요. 픽스앤패스는 중개 플랫폼으로, 수리 과정 및 결과에 대해 직접적인 보상 책임을 지지 않습니다. 특히, 현장 방문 및 견적 산출 과정에서 발생하는 실비(출장비 등)는 당사(픽스앤패스)와 무관하며 당사자 간의 협의에 따릅니다.`;

type Props = {
  open: boolean;
  variant: "contractor" | "requester";
  onClose: () => void;
  /** 사용자가 동의함을 선택하고 확인을 눌렀을 때만 호출 */
  onAgreed: () => void;
};

export default function LiabilityDisclaimerModal({ open, variant, onClose, onAgreed }: Props) {
  const [choice, setChoice] = useState<"agree" | "disagree" | "">("");

  useEffect(() => {
    if (open) setChoice("");
  }, [open]);

  if (!open) return null;

  const body = variant === "contractor" ? CONTRACTOR_TEXT : REQUESTER_TEXT;
  const title = variant === "contractor" ? "견적 제출 전 면책 고지" : "업체 선택 전 면책 고지";

  const handleConfirm = () => {
    if (choice === "agree") {
      onAgreed();
      onClose();
      return;
    }
    if (choice === "disagree") {
      alert(
        "면책 고지에 동의하지 않으면 서비스를 정상적으로 이용하기 어렵습니다. 동의하신 뒤 다시 시도해 주세요."
      );
      onClose();
      return;
    }
    alert("동의함 또는 동의하지 않음 중 하나를 선택해 주세요.");
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto shadow-xl border border-slate-200">
        <div className="p-5 border-b border-slate-100">
          <h2 className="text-lg font-black text-slate-900">{title}</h2>
          <p className="text-xs text-rose-700 font-semibold mt-2">고액 계약·내방 서비스 관련 필수 확인입니다.</p>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{body}</p>
          <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="liability-choice"
                className="mt-1"
                checked={choice === "agree"}
                onChange={() => setChoice("agree")}
              />
              <span className="text-sm font-bold text-slate-900">동의함</span>
            </label>
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="liability-choice"
                className="mt-1"
                checked={choice === "disagree"}
                onChange={() => setChoice("disagree")}
              />
              <span className="text-sm font-bold text-slate-900">동의하지 않음</span>
            </label>
          </div>
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              취소
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              className="px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-bold hover:bg-slate-800"
            >
              확인
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
