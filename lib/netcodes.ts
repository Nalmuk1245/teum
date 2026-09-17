// 체인 코드 정규화 + 전송 경로 선택 — 순수 로직 (네트워크·전역 상태 없음, 테스트 대상).
//
// 문제였던 것 셋:
//  1) 코인당 체인 하나(바낸 기본 체인, 모르면 ERC20)로 고정 → 그 체인이 막히면 끝.
//  2) 거래소마다 체인 표기가 다르다(바낸 ARBITRUM / 업비트 ?, 바낸 AVAXC / OKX Avalanche).
//     문자열이 안 맞으면 "아무 체인이나 열림"(OR)으로 완화됐다 — 게이트가 단조 완화.
//  3) 출금·입금주소 조회에 바낸 코드를 다른 거래소에 그대로 넘겼다.
//
// 여기서는 (2)를 canonChain(모든 표기 → 우리 chainKey)으로, (1)을 pickRoute(양쪽
// 거래소가 그 체인을 열어 둔 후보 중 ETA·수수료 최소)로 푼다. (3)은 transfers.ts의
// venueNetCode가 저장된 거래소 원문 코드를 돌려주는 것으로 푼다.
//
// 모르는 것은 모른다고 한다: 매핑 안 되는 코드는 chainKey "" — 그런 행만 있는
// 거래소는 그 체인 상태를 null(미확인)로 두고, 확인된 행이 있는데 우리 체인이
// 없으면 false(미지원)다. 둘 다 라이브 실행을 막는다. 예전처럼 OR로 열지 않는다.

import type { Venue, WalletStatus } from "./types";
import { chainKeyFromLabel, getChain } from "./chains";

/** 거래소 한 곳의 코인 한 종 · 체인 한 줄. `net`은 그 거래소의 원문 코드다. */
export type NetRow = {
  net: string;
  /** canonChain 결과. ""이면 우리가 모르는 체인 — 라우팅에 못 쓴다. */
  chainKey: string;
  deposit: boolean;
  withdraw: boolean;
  feeCoin?: number;
  confirms?: number;
  /** 거래소가 붙인 사람용 이름 (바낸 networkList[].name) */
  label?: string;
  isDefault?: boolean;
};
export type NetsByVenue = Partial<Record<Venue, NetRow[]>>;

// 정확 일치 표(대문자) — 바낸·바이비트·OKX·업비트에서 실제로 보이는 표기.
// 코인 티커와 겹치는 코드(SOL, TRX, XRP, ETH…)는 그 코인의 자기 체인이므로 결과가 같다.
const EXACT: Record<string, string> = {
  ETH: "ethereum", ERC20: "ethereum", "ERC-20": "ethereum", ETHEREUM: "ethereum",
  BSC: "bsc", BEP20: "bsc", "BEP-20": "bsc", BNB: "bsc", "BNB SMART CHAIN": "bsc", "BNB CHAIN": "bsc",
  TRX: "tron", TRC20: "tron", "TRC-20": "tron", TRON: "tron",
  SOL: "solana", SOLANA: "solana", SPL: "solana",
  XRP: "xrp", XRPL: "xrp", "XRP LEDGER": "xrp", RIPPLE: "xrp",
  MATIC: "polygon", POL: "polygon", POLYGON: "polygon", "POLYGON POS": "polygon",
  ARBITRUM: "arbitrum", ARB: "arbitrum", ARB1: "arbitrum", ARBONE: "arbitrum", "ARBITRUM ONE": "arbitrum", ARBEVM: "arbitrum",
  OPTIMISM: "optimism", OP: "optimism", OPETH: "optimism", "OP MAINNET": "optimism",
  BASE: "base", BASEEVM: "base",
  AVAXC: "avalanche", AVAX: "avalanche", "AVAX-C": "avalanche", AVAXCCHAIN: "avalanche", CCHAIN: "avalanche", "AVALANCHE C": "avalanche", "AVALANCHE C-CHAIN": "avalanche",
  KAIA: "kaia", KLAY: "kaia", KLAYTN: "kaia",
  ZKSYNCERA: "zksync", ZKSYNC: "zksync", "ZKSYNC ERA": "zksync",
  FTM: "fantom", FANTOM: "fantom", CELO: "celo", RONIN: "ronin", SCROLL: "scroll", LINEA: "linea",
  MANTLE: "mantle", SONIC: "sonic", METIS: "metis", CRONOS: "cronos", CRO: "cronos", GNOSIS: "gnosis", XDAI: "gnosis",
  // 폐지된 비콘체인 — 절대 라우팅하지 않는다.
  BEP2: "",
};

/**
 * 거래소 체인 코드/이름 → 우리 chainKey. 모르면 "".
 * `base`를 주면 "코드 == 코인 티커"(BTC의 BTC, ADA의 ADA)를 그 코인의 자기 체인
 * `native:TICKER`로 잡는다 — 레지스트리에 없는 네이티브 체인도 거래소끼리는 맞춰볼 수 있다.
 */
export function canonChain(raw: string | null | undefined, base?: string): string {
  if (!raw) return "";
  const u = raw.trim().toUpperCase();
  if (!u) return "";
  if (u in EXACT) return EXACT[u];
  if (base && u === base.trim().toUpperCase()) return `native:${u}`;
  return chainKeyFromLabel(raw);
}

/** 사람용 체인 이름 — 레지스트리 라벨 > 거래소 라벨 > 키 그대로. */
export function chainLabelOf(chainKey: string, fallback?: string): string {
  const reg = getChain(chainKey)?.label;
  if (reg) return reg;
  if (fallback) return fallback; // 큐레이션 라벨(Stellar, Bitcoin…)이 "XLM (native)"보다 낫다
  return chainKey.startsWith("native:") ? `${chainKey.slice(7)} (native)` : chainKey;
}

export type RouteChoice = {
  chainKey: string;
  label: string;
  confirms: number;
  /** 매수 거래소 출금 가능 여부 — null = 확인 불가(키 없음·코드 미매핑) */
  withdraw: boolean | null;
  /** 매도 거래소 입금 가능 여부 */
  deposit: boolean | null;
  feeCoin?: number;
  etaMin: number;
  /** 이 체인 말고도 양쪽 다 열린 체인이 몇 개 더 있나 */
  alternatives: number;
  /** 왜 이 체인인가 / 왜 못 가나 — UI 노트용 */
  reason: string;
};

type Side = "withdraw" | "deposit";

/** 한 거래소의 (코인, 체인) 상태. rows 없음 = 체인 데이터 자체가 없는 거래소(빗썸·키 없음). */
export function venueChainState(
  rows: NetRow[] | undefined,
  chainKey: string,
  side: Side,
  coinLevel: WalletStatus | null,
): boolean | null {
  if (!rows) return coinLevel ? coinLevel[side] : null;
  const hit = rows.find((r) => r.chainKey === chainKey);
  if (hit) return hit[side];
  // 매핑 안 된 행이 남아 있으면 "그 중 하나가 우리 체인일 수도" — 미확인.
  if (rows.some((r) => !r.chainKey)) return null;
  return false; // 체인 목록은 다 아는데 우리 체인이 없다 = 미지원
}

/**
 * 매수 거래소 → 매도 거래소 전송 체인 선택.
 * 후보 = 두 거래소가 아는 체인 ∪ 기본 체인. 양쪽 다 확인된 열림인 후보 중
 * ETA 짧은 순 → 수수료 낮은 순. 하나도 없으면 기본 체인을 돌려주되 상태는
 * 그 체인의 실제 값(막힘/미확인)이다 — 실행 게이트가 그걸로 막는다.
 */
export function pickRoute(args: {
  base: string;
  buyVenue: Venue;
  sellVenue: Venue;
  nets: NetsByVenue;
  coinLevel: { buy: WalletStatus | null; sell: WalletStatus | null };
  /** 체인 데이터가 전혀 없을 때 쓰는 기본 체인 (큐레이션/바낸 기본) */
  fallback: { chainKey: string; label: string; confirms: number; feeCoin?: number };
  eta: (label: string, confirms: number) => number;
}): RouteChoice {
  const { base, buyVenue, sellVenue, nets, coinLevel, fallback, eta } = args;
  const rowsB = nets[buyVenue];
  const rowsS = nets[sellVenue];

  const keys = new Set<string>();
  for (const r of rowsB ?? []) if (r.chainKey) keys.add(r.chainKey);
  for (const r of rowsS ?? []) if (r.chainKey) keys.add(r.chainKey);
  if (fallback.chainKey) keys.add(fallback.chainKey);
  // 아무 정보도 없으면(키 전무 + 큐레이션도 없음) 기본 체인 하나로만 판단한다.
  if (!keys.size) keys.add(fallback.chainKey || "ethereum");

  const evalKey = (chainKey: string) => {
    const rb = rowsB?.find((r) => r.chainKey === chainKey);
    const rs = rowsS?.find((r) => r.chainKey === chainKey);
    const withdraw = venueChainState(rowsB, chainKey, "withdraw", coinLevel.buy);
    const deposit = venueChainState(rowsS, chainKey, "deposit", coinLevel.sell);
    const isFallback = chainKey === fallback.chainKey;
    const label = rb?.label ?? rs?.label ?? chainLabelOf(chainKey, isFallback ? fallback.label : undefined);
    const confirms = rb?.confirms ?? rs?.confirms ?? (isFallback ? fallback.confirms : 0);
    const feeCoin = rb?.feeCoin ?? (isFallback ? fallback.feeCoin : undefined);
    return { chainKey, label, confirms, withdraw, deposit, feeCoin, etaMin: eta(label, confirms) };
  };
  const all = [...keys].map(evalKey);
  const open = all
    .filter((c) => c.withdraw === true && c.deposit === true)
    .sort((a, b) => a.etaMin - b.etaMin || (a.feeCoin ?? Infinity) - (b.feeCoin ?? Infinity));

  if (open.length) {
    const c = open[0];
    return {
      ...c, alternatives: open.length - 1,
      reason: open.length > 1
        ? `${c.label} 선택 (양쪽 열림 ${open.length}개 중 ETA 최단)`
        : `${c.label} — 양쪽 열린 유일한 체인`,
    };
  }
  // 열린 체인이 없다 — 기본 체인의 실제 상태를 그대로 보여준다.
  const c = all.find((x) => x.chainKey === fallback.chainKey) ?? all[0];
  const why = c.withdraw === false ? `${buyVenue} 출금 막힘`
    : c.deposit === false ? `${sellVenue} 입금 막힘`
    : c.withdraw === null ? `${buyVenue} 상태 미확인`
    : `${sellVenue} 상태 미확인`;
  const knownOpenElsewhere = all.filter((x) => x.withdraw === true || x.deposit === true).length;
  return {
    ...c, alternatives: 0,
    reason: `${c.label}: ${why}${knownOpenElsewhere && all.length > 1 ? " · 다른 체인도 양쪽 동시 열림 없음" : ""}`,
  };
}
