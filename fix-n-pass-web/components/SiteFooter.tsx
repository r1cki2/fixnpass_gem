export default function SiteFooter() {
  return (
    <footer
      role="contentinfo"
      className="fixed bottom-0 left-0 right-0 z-30 shrink-0 border-t border-gray-200 bg-gray-100/95 backdrop-blur-sm"
    >
      <div className="max-w-5xl mx-auto px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
        <p className="text-[11px] leading-relaxed text-gray-500 text-center md:text-left">
          <span className="font-semibold text-gray-600">책임 한계 및 법적 고지</span>
          {" : "}
          픽스앤패스가 제공하는 정보 및 업체 매칭 서비스는 사용자의 편의를 위한 것이며, 실제 공사 계약의 당사자는 건물주와 보수업체입니다. 픽스앤패스는 중개 과정에서 발생하는 업체와의 분쟁, 수리 결과물에 대한 하자, 방문 일정 미이행 등에 대해 보증하거나 책임지지 않습니다. 모든 거래의 최종 결정과 책임은 사용자 본인에게 귀속됩니다.
        </p>
      </div>
    </footer>
  );
}
