import { NextResponse } from "next/server";
import type { Opportunity } from "@/lib/types";
import type { StepId } from "@/lib/execPlan";
import { CONFIG } from "@/lib/config";
import { notifyNow } from "@/lib/telegram";
import { runStep, idemGet, idemSet } from "@/lib/execStep";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      stepId?: StepId; opportunity?: Opportunity; sizeUsd?: number;
      rollback?: boolean; qty?: number; sinceTs?: number;
      fills?: { buyQuote?: number; buyCcy?: string; buyQty?: number; sellQuote?: number; sellCcy?: string; sellQty?: number; hedgeOpenQuote?: number; hedgeCloseQuote?: number };
    txs?: { step: string; hash: string; url: string | null }[];
      idempotencyKey?: string;
      durations?: Record<string, number>;
    };
    if (!body.stepId || !body.opportunity) {
      return NextResponse.json({ ok: false, message: "stepId + opportunity 필요" }, { status: 400 });
    }
    // Live mode: mock opportunities carry made-up prices — never execute them
    // against real APIs. (DRY_RUN lets them through for demo flow.)
    if (body.opportunity.mock && !CONFIG.DRY_RUN) {
      return NextResponse.json({ ok: false, message: "목업 기회는 실행 불가" }, { status: 400 });
    }
    // Live mode: money-moving endpoint requires the shared token (EXEC_TOKEN).
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token) return NextResponse.json({ ok: false, message: "라이브 모드에는 EXEC_TOKEN 설정 필수" }, { status: 403 });
      if (req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패" }, { status: 403 });
      }
    }
    // Idempotency: replay a cached SUCCESS for the same run+step (protects the
    // "network died but the server executed" case). Failures are never cached,
    // so a genuine retry re-executes.
    const idem = body.idempotencyKey;
    if (idem) {
      const hit = idemGet(idem);
      if (hit) return NextResponse.json({ ...hit, message: `${hit.message} · (재전송 방지 — 이전 결과)` });
    }
    const result = await runStep(body.stepId, body.opportunity, body.sizeUsd ?? 0, {
      rollback: !!body.rollback, qty: body.qty, sinceTs: body.sinceTs, fills: body.fills, durations: body.durations, txs: body.txs,
    });
    if (idem && result.ok) idemSet(idem, result);
    // Live failure on a money step → phone alert (LIVE only; DRY sims fail loudly
    // in the UI already and would be noise).
    if (!result.ok && !CONFIG.DRY_RUN && !body.rollback) {
      void notifyNow(`⚠️ <b>${body.opportunity.base}</b> ${body.stepId} 실패\n${result.message ?? ""}`);
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { ok: false, message: e instanceof Error ? e.message : "step failed" },
      { status: 500 },
    );
  }
}
