import { NextResponse } from "next/server";
import { addManualToken, listManualTokens, removeManualToken } from "@/lib/manualTokens";
import { CONFIG } from "@/lib/config";

export const dynamic = "force-dynamic";

// 수동 컨트랙트 등록 — 이 주소로 실제 자금이 나간다. 라이브 모드에선 다른
// 돈 액션과 같은 EXEC_TOKEN을 요구한다 (등록 자체가 송금 목적지를 정하는 행위).
function authed(req: Request): NextResponse | null {
  if (CONFIG.DRY_RUN) return null;
  const token = process.env.EXEC_TOKEN;
  if (!token) return NextResponse.json({ error: "라이브 모드에는 EXEC_TOKEN 설정 필수" }, { status: 403 });
  if (req.headers.get("x-exec-token") !== token) return NextResponse.json({ error: "인증 실패" }, { status: 403 });
  return null;
}

export async function GET() {
  return NextResponse.json({ tokens: listManualTokens() });
}

export async function POST(req: Request) {
  const deny = authed(req);
  if (deny) return deny;
  try {
    const b = (await req.json()) as { base?: string; chain?: string; address?: string; force?: boolean };
    if (!b.base || !b.chain || !b.address) return NextResponse.json({ ok: false, message: "base·chain·address 필요" }, { status: 400 });
    const r = await addManualToken(b.base, b.chain, b.address, { force: !!b.force });
    return NextResponse.json(r, { status: r.ok ? 200 : 422 });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "등록 실패" }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const deny = authed(req);
  if (deny) return deny;
  const u = new URL(req.url);
  const base = u.searchParams.get("base"), chain = u.searchParams.get("chain");
  if (!base || !chain) return NextResponse.json({ ok: false, message: "base·chain 필요" }, { status: 400 });
  return NextResponse.json({ ok: removeManualToken(base, chain) });
}
