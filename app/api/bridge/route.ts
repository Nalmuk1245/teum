import { NextResponse } from "next/server";
import { CONFIG } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { okxGet, OKX_CHAIN_ID, QUOTE_STABLES, dexConfigured } from "@/lib/dex";
import { loadSecretsIntoEnv } from "@/lib/secrets";
loadSecretsIntoEnv(); // 설정창 키 주입 — 부팅 후 첫 스캔 전에 이 라우트가 먼저 맞아도 "키 필요"가 안 뜨게
import { sendRawEvmTx, walletAddress } from "@/lib/wallet";
import { notifyNow } from "@/lib/telegram";

export const dynamic = "force-dynamic";

// 크로스체인 리밸런싱 (OKX v6 cross-chain) — 지갑의 스테이블을 체인 간 이동.
// GET  ?from=ethereum&to=base&amountUsd=500 → 라우트/수수료/ETA 견적
// POST 동일 body → build-tx → 서명·전송 (EVM만, 라우터 화이트리스트)

function stableRaw(chain: string, amountUsd: number): string | null {
  const st = QUOTE_STABLES[chain];
  if (!st) return null;
  return (BigInt(Math.round(amountUsd * 100)) * BigInt(10) ** BigInt(st.decimals - 2)).toString();
}

async function quote(from: string, to: string, amountUsd: number) {
  const f = OKX_CHAIN_ID[from], t = OKX_CHAIN_ID[to];
  const fs = QUOTE_STABLES[from], ts = QUOTE_STABLES[to];
  const amount = stableRaw(from, amountUsd);
  if (!f || !t || !fs || !ts || !amount) return { error: "미지원 체인" };
  const data = await okxGet("/api/v6/dex/cross-chain/quote", {
    fromChainIndex: f, toChainIndex: t,
    fromTokenAddress: fs.address, toTokenAddress: ts.address,
    amount, slippage: "0.01",
  });
  // v6: bridgeName은 routerList[*] 바로 아래다 (v5의 router.bridgeName 아님 —
  // 옛 경로를 읽어서 UI에 "?"가 떴다). OKX는 어그리게이터라 라우트마다 브릿지가
  // 다르다 — 실측 예: ETH→Base가 STARGATE V2 BUS MODE로 잡혔다.
  const d = data[0] as { routerList?: { toTokenAmount?: string; estimateTime?: string; bridgeName?: string; otherNativeFee?: string }[] } | undefined;
  const r = d?.routerList?.[0];
  if (!r?.toTokenAmount) return { error: "라우트 없음" };
  const outUsd = Number(r.toTokenAmount) / 10 ** ts.decimals;
  return {
    bridge: r.bridgeName ?? "?",
    inUsd: amountUsd,
    outUsd,
    feeUsd: amountUsd - outUsd,
    etaMin: Math.ceil(Number(r.estimateTime ?? 0) / 60),
    // 대안 라우트 — 어그리게이터가 뭘 비교했는지 보이게 (수수료 = in − out)
    alts: (d?.routerList ?? []).slice(1, 3).map((x) => ({
      bridge: x.bridgeName ?? "?",
      outUsd: Number(x.toTokenAmount ?? 0) / 10 ** ts.decimals,
      etaMin: Math.ceil(Number(x.estimateTime ?? 0) / 60),
    })),
  };
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const from = u.searchParams.get("from") ?? "ethereum";
  const to = u.searchParams.get("to") ?? "base";
  const amountUsd = Number(u.searchParams.get("amountUsd") ?? 500);
  if (!dexConfigured()) return NextResponse.json({ error: "OKX_WEB3 키 필요" });
  try {
    return NextResponse.json(await quote(from, to, amountUsd));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "quote failed" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { from?: string; to?: string; amountUsd?: number };
    const from = body.from ?? "ethereum", to = body.to ?? "base";
    const amountUsd = Number(body.amountUsd ?? 0);
    if (!(amountUsd > 0)) return NextResponse.json({ ok: false, message: "금액 필요" }, { status: 400 });
    if (isKilled()) return NextResponse.json({ ok: false, message: "킬 스위치 활성" }, { status: 423 });
    if (from === "solana" || to === "solana") return NextResponse.json({ ok: false, message: "브릿지는 EVM 체인만" }, { status: 400 });
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
    }
    if (!dexConfigured()) return NextResponse.json({ ok: false, message: "OKX_WEB3 키 필요" });

    if (CONFIG.DRY_RUN) {
      const q = await quote(from, to, amountUsd);
      return NextResponse.json({ ok: !("error" in q), dryRun: true, ...q, message: "브릿지 (모의) — 견적만" });
    }

    const walletAddr = walletAddress();
    if (!walletAddr) return NextResponse.json({ ok: false, message: "지갑 키 없음" });
    const f = OKX_CHAIN_ID[from], t = OKX_CHAIN_ID[to];
    const fs = QUOTE_STABLES[from], ts = QUOTE_STABLES[to];
    const amount = stableRaw(from, amountUsd);
    if (!f || !t || !fs || !ts || !amount) return NextResponse.json({ ok: false, message: "미지원 체인" }, { status: 400 });
    const data = await okxGet("/api/v6/dex/cross-chain/build-tx", {
      fromChainIndex: f, toChainIndex: t,
      fromTokenAddress: fs.address, toTokenAddress: ts.address,
      amount, slippage: "0.01",
      userWalletAddress: walletAddr, receiveAddress: walletAddr,
    });
    const d = data[0] as { tx?: { to?: string; data?: string; value?: string; gasLimit?: string; gas?: string } } | undefined;
    if (!d?.tx?.to || !d.tx.data) return NextResponse.json({ ok: false, message: "build-tx 실패 (라우트/승인 확인)" });
    const res = await sendRawEvmTx(
      { chain: from, to: d.tx.to, data: d.tx.data, value: d.tx.value ?? "0", gas: d.tx.gasLimit ?? d.tx.gas },
      [d.tx.to],
    );
    if (res.ok) void notifyNow(`🌉 브릿지 — $${amountUsd} ${from} → ${to}\ntx: ${res.hash}`);
    return NextResponse.json({ ok: res.ok, dryRun: res.dryRun, tx: res.hash, message: res.message });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "bridge failed" }, { status: 500 });
  }
}
