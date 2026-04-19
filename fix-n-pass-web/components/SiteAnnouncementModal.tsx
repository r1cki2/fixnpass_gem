"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";

type Announcement = { id: number; title?: string | null; message: string; updated_at?: string };

export default function SiteAnnouncementModal() {
  const [item, setItem] = useState<Announcement | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const base = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (!base) return;
    (async () => {
      try {
        const res = await fetch(`${base}/api/site-announcement`);
        const json = await res.json();
        const d = json.data as Announcement | null;
        if (!d?.message?.trim()) return;
        const key = `fixnpass_popup_dismiss_${d.id}`;
        if (typeof window !== "undefined" && localStorage.getItem(key)) return;
        setItem(d);
        setOpen(true);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  if (!open || !item) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(`fixnpass_popup_dismiss_${item.id}`, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full p-6 relative border border-slate-200">
        <button
          type="button"
          onClick={dismiss}
          className="absolute top-3 right-3 p-2 rounded-lg text-slate-400 hover:text-slate-800 hover:bg-slate-100"
          aria-label="닫기"
        >
          <X className="w-5 h-5" />
        </button>
        {item.title ? <h2 className="text-lg font-bold text-slate-900 pr-10 mb-2">{item.title}</h2> : null}
        <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{item.message}</p>
        <button
          type="button"
          onClick={dismiss}
          className="mt-6 w-full py-3 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700"
        >
          확인
        </button>
      </div>
    </div>
  );
}
