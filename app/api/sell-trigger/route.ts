import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { createTrigger, cancelTrigger, listTriggers, type SellMode, type FireMode } from "@/lib/sellTriggers";

export const dynamic = "force-dynamic";

// 자동 매도 트리거. 돈이 나가는 기능이라 라이브는 EXEC_TOKEN 필수.
function auth(req: Request): NextResponse | null {
  if (CONFIG.DRY_RUN) return null;
  const token = process.env.EXEC_TOKEN;
  if (!token) return NextResponse.json({ error: "라이브 모드에는 EXEC_TOKEN 필수" }, { status: 403 });
  if (req.headers.get("x-exec-token") !== token) return NextResponse.json({ error: "인증 실패" }, { status: 403 });
  return null;
}

export async function GET() {
  return NextResponse.json({ triggers: listTriggers(), dryRun: CONFIG.DRY_RUN });
}

export async function POST(req: Request) {
  const deny = auth(req);
  if (deny) return deny;
  try {
    const b = (await req.json()) as {
      venue?: "upbit" | "binance" | "bithumb"; base?: string; mode?: SellMode; fire?: FireMode;
      targetPrice?: number; floorPrice?: number; expectQty?: number; repeat?: boolean;
    };
    if (!b.venue || !b.base || !b.mode) return NextResponse.json({ error: "venue·base·mode 필요" }, { status: 400 });
    if ((b.mode === "limit") && !(b.targetPrice! > 0)) return NextResponse.json({ error: "지정가는 목표가 필요" }, { status: 400 });
    const t = createTrigger({
      venue: b.venue, base: b.base.toUpperCase(), mode: b.mode, fire: b.fire ?? "hybrid",
      targetPrice: b.targetPrice, floorPrice: b.floorPrice, expectQty: b.expectQty, repeat: !!b.repeat,
    });
    return NextResponse.json({ ok: true, trigger: t });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "등록 실패" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const deny = auth(req);
  if (deny) return deny;
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id 필요" }, { status: 400 });
  return NextResponse.json({ ok: cancelTrigger(id) });
}
