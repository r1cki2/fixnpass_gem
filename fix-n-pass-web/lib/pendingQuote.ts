const STORAGE_KEY = "fixnpass_pending_quote_request";

export type PendingQuotePayload = {
  repair_request_id: number;
  selected_items: string[];
};

export function savePendingQuoteRequest(payload: PendingQuotePayload) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

export function loadPendingQuoteRequest(): PendingQuotePayload | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingQuotePayload;
    if (!p || typeof p.repair_request_id !== "number" || !Array.isArray(p.selected_items)) return null;
    return p;
  } catch {
    return null;
  }
}

export function clearPendingQuoteRequest() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** 게스트 분석 건을 로그인한 의뢰인 계정으로 견적 요청까지 마칩니다. */
export async function submitPendingQuoteRequest(userId: string): Promise<{
  ok: boolean;
  skipped?: boolean;
  error?: string;
}> {
  const p = loadPendingQuoteRequest();
  if (!p) return { ok: false, skipped: true };

  const baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!baseUrl) return { ok: false, error: "API 주소가 설정되지 않았습니다." };

  // 수리업체 계정으로 로그인한 경우: 임시 draft 건 삭제 후 안내
  try {
    const profileRes = await fetch(`${baseUrl}/api/me/profile?user_id=${encodeURIComponent(userId)}`);
    const profileJson = await profileRes.json().catch(() => ({} as any));
    const role = profileJson?.data?.profile?.role;
    if (role === "contractor") {
      try {
        await fetch(`${baseUrl}/api/pending-quote/discard-draft`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            repair_request_id: p.repair_request_id,
            user_id: userId,
          }),
        });
      } catch {
        /* ignore cleanup error */
      }
      clearPendingQuoteRequest();
      return {
        ok: false,
        error:
          "수리 업체 계정은 견적을 요청하실 수 없습니다. 수리 의뢰인 계정으로 회원가입 하신 후 재요청 부탁드립니다.",
      };
    }
  } catch {
    /* ignore profile read failure and continue */
  }

  const res = await fetch(`${baseUrl}/api/update-request`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repair_request_id: p.repair_request_id,
      requester_id: userId,
      selected_items: p.selected_items,
      status: "requested",
    }),
  });

  if (!res.ok) {
    let detail = "견적 요청 등록에 실패했습니다.";
    try {
      const j = await res.json();
      if (j.detail) detail = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail);
    } catch {
      /* ignore */
    }
    if (res.status === 403) {
      clearPendingQuoteRequest();
      return { ok: false, error: detail };
    }
    return { ok: false, error: detail };
  }

  clearPendingQuoteRequest();
  return { ok: true };
}
