"use client";

import { useEffect } from "react";

declare global {
  interface Window {
    daum?: any;
  }
}

export default function AddressSearchInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  useEffect(() => {
    if (window.daum?.Postcode) return;
    const script = document.createElement("script");
    script.src = "//t1.daumcdn.net/mapjsapi/bundle/postcode/prod/postcode.v2.js";
    script.async = true;
    document.body.appendChild(script);
    return () => {
      if (document.body.contains(script)) document.body.removeChild(script);
    };
  }, []);

  const openSearch = () => {
    if (!window.daum?.Postcode) {
      alert("주소 검색 스크립트를 불러오는 중입니다. 잠시 후 다시 시도해주세요.");
      return;
    }
    new window.daum.Postcode({
      oncomplete: (data: any) => {
        const base = data.roadAddress || data.jibunAddress || "";
        onChange(base.trim());
      },
    }).open();
  };

  return (
    <div className="flex gap-2">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full px-4 py-3 border rounded-lg"
        placeholder={placeholder || "도로명/지번주소 검색 후 선택"}
      />
      <button type="button" onClick={openSearch} className="px-3 py-2 border rounded-lg text-sm">
        주소검색
      </button>
    </div>
  );
}
