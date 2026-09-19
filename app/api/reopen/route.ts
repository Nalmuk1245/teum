import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { loadSecretsIntoEnv } from "@/lib/secrets";
import { reopenCfg, reopenSnapshot, setReopenCfg, startReopenLoops, type ReopenAutoCfg } from "@/lib/reopen";

export const dynamic = "force-dynamic";

// GET → 감시 대상·재개 예정·사전 포지션·설정. POST {cfg} → 설정 변경.
// 라이브에서 armed/preposition을 켜는 건 돈이 나가는 일이라 EXEC_TOKEN이 있어야 한다.
export async function GET() {
  startReopenLoops();
  return NextResponse.json({ ...reopenSnapshot(), dryRun: CONFIG.DRY_RUN });
}

export async function POST(req: Request) {
  try {
    loadSecretsIntoEnv();
    const body = (await req.json()) as { cfg?: Partial<ReopenAutoCfg> };
    const p = body.cfg ?? {};
    const arming = (p.armed && !reopenCfg().armed) || (p.preposition && !reopenCfg().preposition);
    if (!CONFIG.DRY_RUN && arming) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN) — 라이브에서 자동 실행을 켜려면 토큰 필요" }, { status: 403 });
      }
    }
    const clean: Partial<ReopenAutoCfg> = {};
    if (typeof p.armed === "boolean") clean.armed = p.armed;
    if (typeof p.preposition === "boolean") clean.preposition = p.preposition;
    if (Number.isFinite(p.sizeUsd) && (p.sizeUsd as number) > 0) clean.sizeUsd = Math.round(p.sizeUsd as number);
    if (Number.isFinite(p.minNet) && (p.minNet as number) >= 0) clean.minNet = p.minNet as number;
    if (Number.isFinite(p.prepositionLeadMin) && (p.prepositionLeadMin as number) >= 1) clean.prepositionLeadMin = Math.round(p.prepositionLeadMin as number);
    if (Number.isFinite(p.prepositionMaxWaitMin) && (p.prepositionMaxWaitMin as number) >= 1) clean.prepositionMaxWaitMin = Math.round(p.prepositionMaxWaitMin as number);
    if (Array.isArray(p.whitelist)) clean.whitelist = p.whitelist.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    return NextResponse.json({ ok: true, cfg: setReopenCfg(clean) });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "bad request" }, { status: 400 });
  }
}
