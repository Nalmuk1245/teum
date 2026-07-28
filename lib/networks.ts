// Live per-coin network facts (chain, deposit confirms, withdrawal fee) sourced
// from Binance's networkList — replaces the hand-curated tables when keys are
// set. transfers.ts populates the cache during its getall sweep; strategies and
// the depth quote read through these getters, falling back to config when a coin
// isn't in the live map (or no keys). globalThis so all route bundles share it.

import { COIN_NETWORK, COIN_NETWORK_DEFAULT, WITHDRAW_FEE_COIN, TRANSFER_ETA_MIN, TRANSFER_ETA_DEFAULT_MIN } from "./config";

export type LiveNetwork = { chain: string; confirms: number; withdrawFee: number; withdrawMin?: number };
const g = globalThis as unknown as { __arbNetworks?: Map<string, LiveNetwork> };
g.__arbNetworks ??= new Map();

/** Called by transfers.ts with the network entry chosen for each coin. */
export function setLiveNetwork(base: string, n: LiveNetwork) {
  g.__arbNetworks!.set(base, n);
}

/** Chain + deposit confirmations for a coin — live if available, else curated. */
export function coinNetwork(base: string): { chain: string; confirms: number } {
  const live = g.__arbNetworks!.get(base);
  if (live) return { chain: live.chain, confirms: live.confirms };
  return COIN_NETWORK[base] ?? COIN_NETWORK_DEFAULT;
}

/** Real per-coin withdrawal fee (coin units) — live if available, else curated. */
export function withdrawFeeCoin(base: string): number | undefined {
  return g.__arbNetworks!.get(base)?.withdrawFee ?? WITHDRAW_FEE_COIN[base];
}

/** 최소 출금 수량 (코인 단위, 바낸 networkList 라이브) — 미상이면 undefined. */
export function withdrawMinCoin(base: string): number | undefined {
  return g.__arbNetworks!.get(base)?.withdrawMin;
}

// ── 전송 ETA — 컨펌 시간 기반 실질 계산 ──────────────────────────────────────
// 예전엔 코인별 정적 테이블(TRANSFER_ETA_MIN)이었다. 그 값은 두 가지를 놓친다:
// ① 같은 코인도 체인·요구 컨펌 수가 바뀌면 시간이 바뀐다(키가 있으면 바이낸스가
//    코인별 minConfirm을 실시간으로 준다 — setLiveNetwork가 이미 받고 있다).
// ② 테이블에 없는 코인은 전부 10분 취급 — 상장따리가 정확히 그 코인들이다.
//
// 실질 ETA = 출금 처리(거래소 큐·리스크 심사) + 블록타임 × 요구 컨펌 + 입금 반영.
// 앞뒤 상수는 중앙값 기준의 보수적 추정이고, 가운데 항이 코인마다 실제로 다른
// 부분이다 — 라이브 컨펌 수가 들어오면 이 항이 코인별 실측 기반이 된다.
const WITHDRAW_PROCESS_MIN = 2; // 출금 신청 → 브로드캐스트 (핫월렛 큐 + 심사)
const CREDIT_BUFFER_MIN = 1;    // 확정 → 거래소 잔고 반영

// 체인 블록타임(초). 키는 체인 라벨 부분 문자열 — 라이브 라벨("BNB Smart Chain
// (BEP20)")과 큐레이션 라벨("Tron (TRC20)")이 표기가 달라 정확 매칭이 안 된다.
const BLOCK_SEC: [needle: string, sec: number][] = [
  ["bitcoin", 600], ["btc", 600],
  ["dogecoin", 60], ["doge", 60],
  ["litecoin", 150], ["ltc", 150],
  ["cardano", 20], ["ada", 20],
  ["ethereum", 12], ["erc20", 12],
  ["polygon", 2.2], ["matic", 2.2],
  ["arbitrum", 0.3], ["optimism", 2], ["base", 2], ["linea", 2], ["scroll", 3],
  ["zksync", 1], ["mantle", 2], ["blast", 2], ["sonic", 0.5],
  ["bnb", 3], ["bsc", 3], ["bep20", 3],
  ["tron", 3], ["trc20", 3],
  ["avalanche", 2], ["avax", 2],
  ["solana", 0.8], ["xrp", 4], ["stellar", 5], ["xlm", 5],
  ["polkadot", 6], ["cosmos", 6], ["atom", 6],
  ["near", 1.2], ["aptos", 0.3], ["sui", 0.5], ["sei", 0.5],
  ["algorand", 3], ["ton", 5], ["kaia", 1], ["klaytn", 1],
  ["fantom", 1], ["celo", 5], ["cronos", 6], ["hedera", 3], ["kaspa", 1],
];

function blockSecOf(chainLabel: string): number | null {
  const s = chainLabel.toLowerCase();
  for (const [needle, sec] of BLOCK_SEC) if (s.includes(needle)) return sec;
  return null;
}

/**
 * 코인의 실질 전송 ETA(분). 라이브 체인·컨펌(coinNetwork)이 있으면 그 기반,
 * 블록타임을 모르는 체인이면 큐레이션 테이블 → 기본값 순으로 강등한다.
 * 1~90분으로 클램프 — ETA는 리스크 창 크기라 0이나 무한대가 되면 안 된다.
 */
export function transferEtaMin(base: string): number {
  const net = coinNetwork(base);
  const blockSec = blockSecOf(net.chain);
  if (blockSec != null && net.confirms > 0) {
    const eta = WITHDRAW_PROCESS_MIN + (blockSec * net.confirms) / 60 + CREDIT_BUFFER_MIN;
    return Math.min(90, Math.max(1, Math.round(eta * 10) / 10));
  }
  // 강등: 체인을 모르면 코인 테이블, 그것도 없으면 기본값
  return TRANSFER_ETA_MIN[base] ?? TRANSFER_ETA_DEFAULT_MIN;
}
