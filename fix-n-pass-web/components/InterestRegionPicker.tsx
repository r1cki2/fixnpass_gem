"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { REGION_OPTIONS_BY_SIDO, SIDO_OPTIONS } from "@/lib/regions";
import { getDefaultInterestRegions, matchRegionFromAddress } from "@/lib/regionAdjacency";

function sidoOfLabel(label: string): string | null {
  for (const sido of SIDO_OPTIONS) {
    if (label.startsWith(`${sido} `)) return sido;
  }
  return null;
}

type Props = {
  value: string[];
  onChange: (next: string[]) => void;
  /** 업체 소재지 주소 — 인접 지역 자동 선택 기준 */
  baseAddress?: string;
};

export default function InterestRegionPicker({ value, onChange, baseAddress }: Props) {
  const [selectedSido, setSelectedSido] = useState<string>(SIDO_OPTIONS[0] || "서울특별시");
  const dragRef = useRef<{ active: boolean; add: boolean }>({ active: false, add: true });
  const anchorRef = useRef<{ sido: string; index: number } | null>(null);

  useEffect(() => {
    const end = () => {
      dragRef.current.active = false;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  useEffect(() => {
    const m = matchRegionFromAddress(baseAddress || "");
    const sido = m ? sidoOfLabel(m) : null;
    if (sido) setSelectedSido(sido);
  }, [baseAddress]);

  const list = REGION_OPTIONS_BY_SIDO[selectedSido] || [];
  const selected = new Set(value);

  const applyBulk = useCallback(
    (labels: string[], add: boolean) => {
      const next = new Set(value);
      for (const lb of labels) {
        if (add) next.add(lb);
        else next.delete(lb);
      }
      onChange([...next]);
    },
    [value, onChange],
  );

  const selectAllSido = () => {
    applyBulk(list, true);
  };

  const clearSido = () => {
    applyBulk(list, false);
  };

  const fillFromBase = () => {
    const next = getDefaultInterestRegions(baseAddress || "");
    if (next.length === 0) {
      alert("소재지 주소에서 시·도와 구·시를 인식하지 못했습니다. 주소 검색으로 입력해 주세요.");
      return;
    }
    onChange([...new Set([...value, ...next])].sort((a, b) => a.localeCompare(b, "ko")));
  };

  const onCellPointerDown = (label: string, index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    if (e.shiftKey && anchorRef.current?.sido === selectedSido) {
      dragRef.current.active = false;
      const a = anchorRef.current.index;
      const lo = Math.min(a, index);
      const hi = Math.max(a, index);
      const slice = list.slice(lo, hi + 1);
      applyBulk(slice, !e.altKey);
      return;
    }
    const was = selected.has(label);
    dragRef.current = { active: true, add: !was };
    anchorRef.current = { sido: selectedSido, index };
    const next = new Set(value);
    if (!was) next.add(label);
    else next.delete(label);
    onChange([...next]);
  };

  const onCellPointerEnter = (label: string) => {
    if (!dragRef.current.active) return;
    const next = new Set(value);
    if (dragRef.current.add) next.add(label);
    else next.delete(label);
    onChange([...next]);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="border rounded-lg px-2 py-2 text-sm min-w-[8rem]"
          value={selectedSido}
          onChange={(e) => {
            setSelectedSido(e.target.value);
          }}
        >
          {SIDO_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="px-3 py-2 rounded-lg bg-slate-800 text-white text-xs font-bold"
          onClick={selectAllSido}
        >
          이 시·도 전체 선택
        </button>
        <button
          type="button"
          className="px-3 py-2 rounded-lg border border-slate-300 text-slate-700 text-xs font-bold"
          onClick={clearSido}
        >
          이 시·도 전체 해제
        </button>
        <button
          type="button"
          className="px-3 py-2 rounded-lg bg-emerald-700 text-white text-xs font-bold"
          onClick={fillFromBase}
        >
          소재지·인접 지역 채우기
        </button>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">
        그리드에서 드래그하면 여러 구·시를 한 번에 선택·해제할 수 있습니다. Shift+클릭으로 구간 선택(Alt+Shift는
        구간 해제)합니다. 처음에는 소재지와 맞닿은 인접 행정구역이 자동으로 잡힙니다.
      </p>
      <div
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 select-none touch-none"
        onPointerLeave={() => {
          /* keep drag until pointerup anywhere */
        }}
      >
        {list.map((label, index) => {
          const on = selected.has(label);
          const short = label.replace(/^[^\s]+\s/, "");
          return (
            <button
              key={label}
              type="button"
              onPointerDown={onCellPointerDown(label, index)}
              onPointerEnter={() => onCellPointerEnter(label)}
              className={`rounded-lg border px-2 py-2.5 text-left text-xs font-semibold transition-colors ${
                on
                  ? "border-blue-500 bg-blue-50 text-blue-900 ring-1 ring-blue-400"
                  : "border-slate-200 bg-white text-slate-700 hover:border-slate-400"
              }`}
            >
              {short}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-slate-400">선택됨 {value.length}곳</p>
    </div>
  );
}
