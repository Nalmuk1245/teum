import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { loadSecretsIntoEnv, saveSecrets, secretsStatus } from "@/lib/secrets";

export const dynamic = "force-dynamic";

// 설정 상태 — 키 원문은 절대 반환하지 않음 (설정 여부 + 힌트만).
export async function GET() {
  loadSecretsIntoEnv();
  return NextResponse.json({
    fields: secretsStatus(),
    dryRun: CONFIG.DRY_RUN,
    execTokenSet: !!process.env.EXEC_TOKEN,
  });
}

// 키 저장 — 라이브 모드에선 EXEC_TOKEN 필요 (키 교체 = 자금 접근 변경).
export async function POST(req: Request) {
  try {
    loadSecretsIntoEnv();
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }
    const body = (await req.json()) as { secrets?: Record<string, string> };
    if (!body.secrets || typeof body.secrets !== "object") {
      return NextResponse.json({ ok: false, message: "secrets 필요" }, { status: 400 });
    }
    const r = saveSecrets(body.secrets);
    return NextResponse.json({ ok: true, ...r, fields: secretsStatus() });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "저장 실패" }, { status: 500 });
  }
}
