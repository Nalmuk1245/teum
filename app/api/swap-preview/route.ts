import { NextResponse } from "next/server";
import { quoteDexPreview, gasPriceWei, gasCostUsd, QUOTE_STABLES, allTokens, dexConfigured } from "@/lib/dex";
import { CHAINS } from "@/lib/chains";
import { CONFIG } from "@/lib/config";

import { loadSecretsIntoEnv } from "@/lib/secrets";

export const dynamic = "force-dynamic";

// 스왑 미리보기 — 매수 전 확인용: 예상 수령·유효 단가·최소 수령(슬리피지)·
// 가격임팩트·수수료·가스·라우팅 + OKX 토큰 안전성(허니팟·전송세).
// GET ?chain=&token=&usd=&decimals?(모르면 토큰리스트→18 순 추정)
export async function GET(req: Request) {
  loadSecretsIntoEnv();
  const u = new URL(req.url);
  const chain = u.searchParams.get("chain") ?? "";
  const token = u.searchParams.get("token") ?? "";
  const usd = Number(u.searchParams.get("usd") ?? 0);
  let decimals = u.searchParams.get("decimals") ? Number(u.searchParams.get("decimals")) : null;
  if (!chain || !token || !(usd > 0)) return NextResponse.json({ error: "chain/token/usd 필요" }, { status: 400 });
  if (!dexConfigured()) return NextResponse.json({ error: "OKX_WEB3 키 필요" });
  const stable = QUOTE_STABLES[chain];
  if (!stable) return NextResponse.json({ error: `${chain}: 기준 스테이블 없음` });

  if (decimals == null) {
    try {
      const list = await allTokens(chain);
      for (const t of list.values()) {
        if (t && t.address.toLowerCase() === token.toLowerCase()) { decimals = t.decimals; break; }
      }
    } catch { /* fall through */ }
    decimals ??= 18;
  }

  const pv = await quoteDexPreview(chain, stable, { address: token, decimals }, usd);
  if (!pv) return NextResponse.json({ error: "견적 실패 (유동성 없음?)" });

  // 유동성 깊이 — 내 규모의 20배(최소 $50k)로 한 번 더 견적해 임팩트 증가로
  // 풀 깊이를 가늠한다. 큰 규모 임팩트가 낮으면 깊은 풀. 실패=그 규모 못 삼킴.
  const probeUsd = Math.max(usd * 20, 50_000);
  const probe = probeUsd > usd ? await quoteDexPreview(chain, stable, { address: token, decimals }, probeUsd) : pv;
  const deepImpact = probe?.priceImpactPct ?? null;
  // 등급: 큰 규모에서도 임팩트 작으면 deep, 견적조차 안 되면 thin.
  const liquidity: "deep" | "ok" | "thin" =
    !probe ? "thin"
    : deepImpact != null && Math.abs(deepImpact) <= 1 ? "deep"
    : deepImpact != null && Math.abs(deepImpact) <= 4 ? "ok"
    : "thin";

  // 가스 USD — 네이티브 시세는 바낸 공개 시세로
  let gasUsd: number | null = null;
  try {
    const native = CHAINS[chain]?.native ?? "ETH";
    const [wei, px] = await Promise.all([
      gasPriceWei(chain),
      fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${native}USDT`, { cache: "no-store", signal: AbortSignal.timeout(4000) })
        .then((r) => r.json()).then((j: { price?: string }) => (j.price ? Number(j.price) : null)).catch(() => null),
    ]);
    if (wei && px) gasUsd = gasCostUsd(pv.gasUnits, wei, px);
  } catch { /* optional */ }

  const slippagePct = CONFIG.MAX_SLIPPAGE_PCT;
  return NextResponse.json({
    expectedOut: pv.toAmount,
    pricePerToken: usd / pv.toAmount,
    minReceive: pv.toAmount * (1 - slippagePct / 100),
    slippagePct,
    priceImpactPct: pv.priceImpactPct,
    tradeFeeUsd: pv.tradeFeeUsd,
    gasUsd,
    route: pv.route,
    honeypot: pv.honeypot,
    taxRatePct: pv.taxRatePct,
    liquidity,           // deep | ok | thin
    probeUsd,            // 깊이 프로브 규모
    probeImpactPct: deepImpact,
  });
}
