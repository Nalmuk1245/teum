import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { checkEntry } from "@/lib/risk";
import { loadSecretsIntoEnv } from "@/lib/secrets";
import { startListingKrRun } from "@/lib/listingKr";

export const dynamic = "force-dynamic";

// POST {base, sizeUsd} → 해외 매수 → 국내 입금 → 개장 순간 매도 런. 라이브는 EXEC_TOKEN.
export async function POST(req: Request) {
  try {
    loadSecretsIntoEnv();
    const body = (await req.json().catch(() => ({}))) as { base?: string; sizeUsd?: number };
    const base = body.base?.toUpperCase();
    const sizeUsd = Number(body.sizeUsd ?? 0);
    if (!base || !(sizeUsd > 0)) return NextResponse.json({ ok: false, message: "base·sizeUsd 필요" }, { status: 400 });
    if (isKilled()) return NextResponse.json({ ok: false, message: "킬 스위치 활성" }, { status: 423 });
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
    }
    const risk = checkEntry(sizeUsd, { listing: true });
    if (risk) return NextResponse.json({ ok: false, message: `리스크 한도 — ${risk}` }, { status: 400 });
    const r = await startListingKrRun(base, sizeUsd);
    return r.ok ? NextResponse.json({ ok: true, runId: r.runId, message: r.note ?? "시작됨" }) : NextResponse.json({ ok: false, message: r.reason }, { status: 409 });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
