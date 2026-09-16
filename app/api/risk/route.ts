import { NextResponse } from "next/server";
import { riskState, setLimits } from "@/lib/risk";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(riskState());
}

// 한도 변경에는 EXEC_TOKEN을 요구하지 않는다 — 이 앱은 로컬 단일 사용자용이고,
// 여기서 막아야 할 건 "LAN의 다른 사람"이 아니라 "브라우저에서 열어둔 다른
// 사이트"다. 그건 middleware.ts의 출처 확인이 DRY·LIVE 가리지 않고 막는다
// (토큰은 라이브에서만 걸리므로 DRY에서 CSRF가 그대로 통했다).
// 토큰은 자금이 실제로 나가는 액션(/api/runs·listing-buy·sell-trigger·unwind…)에 남아 있다.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    maxPerTradeUsd?: number; maxInFlightUsd?: number; maxDailyLossUsd?: number;
  };
  setLimits(body);
  return NextResponse.json(riskState());
}
