import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import type { AutoLevel } from "@/lib/execPlan";
import { CONFIG } from "@/lib/config";
import { snapshot, startRun, confirmRun, retryRun, cancelRun, clearFinished, unwindRun, setEngineKill } from "@/lib/runEngine";

export const dynamic = "force-dynamic";

// 실행엔진 API — UI 미러(runStore)가 폴링(GET)하고 액션(POST)을 위임한다.
// 루프 자체는 서버 모듈(runEngine)이 소유: 탭이 닫혀도 런은 계속 간다.
export async function GET() {
  return NextResponse.json(snapshot());
}

type Action =
  | { action: "start"; opp: Opportunity; sizeUsd: number; hedge: boolean; autoLevel: AutoLevel }
  | { action: "confirm" | "retry" | "cancel"; id: string }
  | { action: "unwind"; id: string; fraction: number }
  | { action: "clear" }
  | { action: "kill"; killed: boolean };

// 돈이 움직이는 액션 — 라이브 모드에선 EXEC_TOKEN 필수. (cancel/clear/kill은
// 정지·정리라 토큰 없이도 허용 — 비상 정지를 인증으로 막지 않는다.)
const MONEY_ACTIONS = new Set(["start", "confirm", "retry", "unwind"]);

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as Action;
    if (!body?.action) return NextResponse.json({ error: "action 필요" }, { status: 400 });
    if (!CONFIG.DRY_RUN && MONEY_ACTIONS.has(body.action)) {
      const token = process.env.EXEC_TOKEN;
      if (!token) return NextResponse.json({ error: "라이브 모드에는 EXEC_TOKEN 설정 필수" }, { status: 403 });
      if (req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ error: "인증 실패" }, { status: 403 });
      }
    }
    switch (body.action) {
      case "start": {
        if (!body.opp || !(body.sizeUsd > 0)) return NextResponse.json({ error: "opp + sizeUsd 필요" }, { status: 400 });
        const r = startRun({ opp: body.opp, sizeUsd: body.sizeUsd, hedge: !!body.hedge, autoLevel: body.autoLevel ?? "manual" });
        return NextResponse.json("error" in r ? { error: r.error } : { id: r.id, ...snapshot() });
      }
      case "confirm": confirmRun(body.id); break;
      case "retry": retryRun(body.id); break;
      case "cancel": cancelRun(body.id); break;
      case "clear": clearFinished(); break;
      case "unwind": await unwindRun(body.id, body.fraction); break;
      case "kill": setEngineKill(!!body.killed); break;
      default: return NextResponse.json({ error: "알 수 없는 action" }, { status: 400 });
    }
    return NextResponse.json(snapshot());
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "runs api failed" }, { status: 500 });
  }
}
