import { NextResponse } from "next/server";
import { CONFIG, TAG_REQUIRED } from "@/lib/config";
import { isKilled } from "@/lib/killswitch";
import { CHAINS, BINANCE_NET } from "@/lib/chains";
import { fetchDepositAddress } from "@/lib/deposits";
import { sendToken, walletAddress } from "@/lib/wallet";
import { resolveWalletAsset } from "@/lib/tokens";
import { notifyNow } from "@/lib/telegram";
import type { Venue } from "@/lib/types";

export const dynamic = "force-dynamic";

// 상장따리 전송: 개인지갑 → 거래소 입금주소. DEX에서 산 코인을 개장 전에 KR
// 거래소로 옮겨 두는 다리다 (개장 후 매도하려면 개장 전에 도착해 있어야 한다).
//
// 실행엔진의 transfer 스텝과 같은 안전 규칙을 그대로 쓴다:
// - 입금주소는 서버가 거래소 API에서 직접 받는다 — 클라이언트 주소 불신.
//   라이브에서 주소 미확인이면 절대 폴백 주소로 보내지 않는다.
// - 컨트랙트는 resolveWalletAsset (수동 등록 → 큐레이션 → 경로 DB 교차 검증).
// - 태그 필수 코인은 태그 미확인 시 차단.
// - 수량은 6자리 내림 (반올림이 잔고 초과를 만들어 리버트되는 사고 방지).
// - 브로드캐스트 후 실패는 ambiguous — 재전송 금지, 익스플로러 확인.
// GET ?base=&chain= → 지갑의 해당 코인 잔고 (수량 프리필용).
export async function GET(req: Request) {
  const u = new URL(req.url);
  const base = u.searchParams.get("base")?.toUpperCase();
  const chain = u.searchParams.get("chain") ?? "";
  const ch = CHAINS[chain];
  if (!base || !ch) return NextResponse.json({ qty: null });
  const owner = process.env.WALLET_ADDR_EVM ?? walletAddress();
  if (!owner || ch.family !== "evm") return NextResponse.json({ qty: null });
  const { erc20Balance, nativeBalance } = await import("@/lib/erc20");
  const asset = await resolveWalletAsset(base, chain);
  if (asset.kind === "token") return NextResponse.json({ qty: await erc20Balance(chain, asset.address, owner, asset.decimals) });
  if (asset.kind === "native") return NextResponse.json({ qty: await nativeBalance(chain, owner) });
  return NextResponse.json({ qty: null, unresolved: true });
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { base?: string; chain?: string; venue?: string; qty?: number };
    const base = body.base?.toUpperCase();
    const chain = body.chain;
    const venue = body.venue as Venue | undefined;
    const qty = Number(body.qty ?? 0);
    if (!base || !chain || !venue) return NextResponse.json({ ok: false, message: "base·chain·venue 필요" }, { status: 400 });
    if (!CHAINS[chain]) return NextResponse.json({ ok: false, message: `미지원 체인: ${chain}` }, { status: 400 });
    if (!(qty > 0)) return NextResponse.json({ ok: false, message: "수량이 0 이하" }, { status: 400 });
    if (isKilled()) return NextResponse.json({ ok: false, message: "킬 스위치 활성" }, { status: 423 });
    if (!CONFIG.DRY_RUN) {
      const token = process.env.EXEC_TOKEN;
      if (!token || req.headers.get("x-exec-token") !== token) {
        return NextResponse.json({ ok: false, message: "인증 실패 (EXEC_TOKEN)" }, { status: 403 });
      }
      if (!walletAddress()) return NextResponse.json({ ok: false, message: "지갑 키 미설정" }, { status: 400 });
    }

    const dry = CONFIG.DRY_RUN;
    const net = BINANCE_NET[chain] ?? chain;
    const fetched = await fetchDepositAddress(venue, base, net);
    if (!fetched?.address && !dry) {
      return NextResponse.json({ ok: false, message: `${venue} 입금주소 미확인 — 송금 차단 (키/코인 지원 확인)` }, { status: 400 });
    }
    if (TAG_REQUIRED.has(base) && !fetched?.tag && !dry) {
      return NextResponse.json({ ok: false, message: `${base} 태그 필수 — 태그 미확인, 송금 차단` }, { status: 400 });
    }

    const asset = await resolveWalletAsset(base, chain);
    if (asset.kind === "unknown" && !dry) {
      return NextResponse.json({ ok: false, message: `${base} 토큰 컨트랙트 미확인 — 송금 차단 (운영 탭 > 수동 컨트랙트 등록)` }, { status: 400 });
    }

    const sendQty = Math.floor(qty * 1e6) / 1e6;
    if (!(sendQty > 0)) return NextResponse.json({ ok: false, message: "전송 수량 0 (6자리 내림 후)" }, { status: 400 });

    const res = await sendToken({
      chain, to: fetched?.address || "0xDRYRUN_DEST", amountHuman: String(sendQty),
      tag: fetched?.tag ?? undefined,
      ...(asset.kind === "token" ? { tokenAddress: asset.address, decimals: asset.decimals } : {}),
      confirms: 1,
    });
    if (res.ok && !dry) void notifyNow(`📤 <b>${base}</b> ${sendQty} → ${venue} 입금 전송 (${chain})`);
    return NextResponse.json({
      ok: res.ok, dryRun: res.dryRun,
      // 브로드캐스트됐는데 실패면 ambiguous — 클라이언트가 재전송 버튼을 잠가야 한다.
      ambiguous: !res.ok && !!res.hash,
      message: `지갑 → ${venue} ${sendQty} ${base} · ${res.message}${fetched?.address ? "" : " · 입금주소 미확인(모의)"}`,
      tx: res.hash ? { hash: res.hash, url: res.dryRun ? null : (CHAINS[chain]?.explorer ? CHAINS[chain].explorer + res.hash : null) } : null,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, message: e instanceof Error ? e.message : "전송 실패" }, { status: 500 });
  }
}
