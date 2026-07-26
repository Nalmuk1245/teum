// 토큰 경로 DB — "어디를 볼지"만 저장한다. "지금 얼마인지"는 절대 저장하지 않는다.
//
// 설계 근거·대안 비교·SQLite 전환 임계는 docs/TOKEN_ROUTE_DB.md.
//
// 저장: 체인별 컨트랙트·decimals·검증 등급·최상위 풀 주소.
//       며칠~몇 달 단위로만 변하는 값인데 지금까지 조회마다 다시 캐왔다
//       (tokenResolve는 메모리 전용 10분 캐시라 재시작하면 전부 날아간다).
// 금지: 실행가·슬리피지·라우트 존재 여부·CEX 가격. 규모와 그 순간 호가 깊이에
//       달린 값이라 캐시로 판단하면 없는 유동성에 주문을 넣게 된다.
//
// ── 경계 ──────────────────────────────────────────────────────────────────────
// 저장 매체는 이 파일 안에만 있다. 호출부는 아래 export 함수들만 쓰고
// `loadSection("tokenRoutes")`를 직접 부르지 않는다. chain-to-chain으로 확장해
// SQLite로 옮길 때 이 파일 내부 교체 + 마이그레이션 한 번으로 끝난다.

import { loadSection, saveSection } from "./persist";
import { CHAINS } from "./chains";

/**
 * 컨트랙트를 얼마나 믿을 수 있는가.
 *  - onchain : 그 체인 RPC로 symbol()을 읽어 base와 일치함을 확인했다.
 *  - curated : CoinGecko 큐레이션 목록만 근거. 사람이 등록한 것이라 스캠 확률은
 *              낮지만 우리가 확인한 건 아니다. 비EVM은 여기까지가 최선이다.
 * 돈이 나가는 경로(출금·전송)는 onchain만 받는다 — verifiedContract() 참고.
 */
export type RouteTrust = "onchain" | "curated";

export type RouteChain = {
  chain: string;
  contract: string;
  decimals: number;
  trust: RouteTrust;
  verifiedAt: number;
  pairAddress?: string;
  liquidityUsd?: number;
  liquidityAt?: number;
};

export type TokenRoute = {
  base: string;
  cgId?: string;
  name?: string;
  chains: RouteChain[];
  updatedAt: number;
  /** CoinGecko가 모르는 티커 — 짧게만 기억해 재조회 폭주를 막는다. */
  unknownAt?: number;
};

type Db = { schema: 1; tokens: Record<string, TokenRoute> };

const SCHEMA = 1;
const ROUTE_TTL = 30 * 24 * 3600_000; // 컨트랙트·검증 재확인 주기
/** 풀 주소·유동성을 재사용해도 되는 기간. 이보다 오래되면 다시 조회한다. */
export const LIQUIDITY_TTL_MS = 3600_000;
const LIQ_TTL = LIQUIDITY_TTL_MS;
const UNKNOWN_TTL = 60_000; // 부정 캐시 — 레이트리밋 오판이 오래 굳지 않게
// persist가 섹션을 통째로 다시 쓰므로 무한정 키우면 저장할 때마다 이벤트 루프가
// 멈춘다. 실측 ~960B/토큰이라 2000개면 약 1.9MB — 쓰기 지연이 눈에 띄기 시작하는
// 2MB 바로 아래다. 넘으면 오래된 것부터 버린다(캐시라 버려도 다시 만들면 된다).
const MAX_TOKENS = 2000;

type G = {
  __arbRoutes?: Db;
  __arbRouteBuild?: Map<string, Promise<TokenRoute | null>>;
  __arbRouteLiq?: Map<string, Promise<void>>;
};
const g = globalThis as unknown as G;
g.__arbRouteBuild ??= new Map();
g.__arbRouteLiq ??= new Map();

function db(): Db {
  if (!g.__arbRoutes) {
    const saved = loadSection<Db>("tokenRoutes");
    g.__arbRoutes = saved?.schema === SCHEMA && saved.tokens ? saved : { schema: SCHEMA, tokens: {} };
  }
  return g.__arbRoutes;
}

function persist() {
  const d = db();
  const keys = Object.keys(d.tokens);
  if (keys.length > MAX_TOKENS) {
    keys.sort((a, b) => (d.tokens[a].updatedAt ?? 0) - (d.tokens[b].updatedAt ?? 0));
    for (const k of keys.slice(0, keys.length - MAX_TOKENS)) delete d.tokens[k];
  }
  saveSection("tokenRoutes", d); // 디바운스 비동기 — 캐시라 즉시 flush할 이유가 없다
}

/** 저장된 경로. 없거나 만료면 null — 채우려면 ensureRoute. */
export function getRoute(base: string): TokenRoute | null {
  const r = db().tokens[base.toUpperCase()];
  if (!r) return null;
  if (r.unknownAt) return Date.now() - r.unknownAt < UNKNOWN_TTL ? r : null;
  if (Date.now() - r.updatedAt > ROUTE_TTL) return null;
  return r;
}

/** 온체인 symbol()이 base와 맞는가. null = 확인 불가(비EVM·RPC 실패). */
async function checkSymbol(chain: string, address: string, base: string): Promise<boolean | null> {
  if (CHAINS[chain]?.family !== "evm") return null; // 비EVM 검증 미배선
  try {
    const { erc20Symbol } = await import("./tokens");
    const sym = await erc20Symbol(chain, address);
    return sym ? sym.toUpperCase() === base.toUpperCase() : null;
  } catch {
    return null;
  }
}

// 우리 체인 키 → DexScreener chainId
const DS_CHAIN: Record<string, string> = {
  ethereum: "ethereum", base: "base", bsc: "bsc", polygon: "polygon",
  arbitrum: "arbitrum", optimism: "optimism", avalanche: "avalanche", solana: "solana",
};

/**
 * DexScreener 최상위(유동성 최대) 풀. 차트 임베드엔 **페어 주소**가 필요하다
 * (토큰 주소로는 빈 화면이 뜬다). 없으면 그 체인엔 볼 만한 풀이 없다는 뜻이기도 하다.
 */
export async function topPair(chain: string, address: string): Promise<{ pairAddress: string; liquidityUsd: number } | null> {
  try {
    const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      cache: "no-store", signal: AbortSignal.timeout(4000),
    });
    const j = (await r.json()) as { pairs?: Array<{ chainId?: string; pairAddress?: string; liquidity?: { usd?: number } }> };
    const wanted = DS_CHAIN[chain] ?? chain;
    const best = (j.pairs ?? [])
      .filter((x) => x.chainId === wanted && x.pairAddress)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    if (!best?.pairAddress) return null;
    return { pairAddress: best.pairAddress, liquidityUsd: best.liquidity?.usd ?? 0 };
  } catch {
    return null;
  }
}

/**
 * 경로를 확보한다 — 있으면 그대로, 없거나 만료면 구축·검증·저장.
 *
 * 컨트랙트를 영속화한다는 건 **틀린 항목도 영속화된다**는 뜻이다. 그래서
 * 온체인 symbol()이 명백히 다른 토큰을 가리키면(false) 저장하지 않고 버린다.
 * 확인 자체가 불가능한 경우(null)는 curated 등급으로 남기되, 돈 나가는 경로는
 * 그 등급을 거부한다.
 *
 * 절대 throw 하지 않는다 — 캐시 구축 실패가 호출 경로를 깨면 안 된다.
 */
export async function ensureRoute(base: string): Promise<TokenRoute | null> {
  const key = base.toUpperCase();
  const hit = getRoute(key);
  if (hit) return hit.unknownAt ? null : hit;

  // 같은 토큰을 동시에 구축하지 않는다 — 프리워밍과 사용자 조회가 겹치는 게 정상이다.
  const inflight = g.__arbRouteBuild!.get(key);
  if (inflight) return inflight;

  const p = (async (): Promise<TokenRoute | null> => {
    try {
      const { resolveToken } = await import("./tokenResolve");
      const t = await resolveToken(key);
      if (!t) {
        // 부정 캐시. 주의: resolveToken은 내부에서 모든 예외를 잡아 null을 주므로
        // 여기 오는 null이 "진짜 미등록"인지 "CoinGecko 429/타임아웃"인지 구분할 수
        // 없다. 그래서 UNKNOWN_TTL을 60초로 짧게 잡는다 — 레이트리밋으로 잘못 든
        // 부정 캐시가 오래 굳지 않게. (구분이 필요해지면 resolveToken이 실패
        // 사유를 돌려주게 바꿔야 한다.)
        db().tokens[key] = { base: key, chains: [], updatedAt: Date.now(), unknownAt: Date.now() };
        persist();
        return null;
      }
      const entries = Object.entries(t.contracts) as [string, { address: string; decimals: number }][];
      const chains = (await Promise.all(entries.map(async ([chain, c]) => {
        const [ok, pair] = await Promise.all([
          checkSymbol(chain, c.address, key),
          topPair(chain, c.address),
        ]);
        if (ok === false) return null; // 다른 토큰 — 저장 금지
        const row: RouteChain = {
          chain, contract: c.address, decimals: c.decimals,
          trust: ok === true ? "onchain" : "curated",
          verifiedAt: Date.now(),
        };
        if (pair) { row.pairAddress = pair.pairAddress; row.liquidityUsd = pair.liquidityUsd; row.liquidityAt = Date.now(); }
        return row;
      }))).filter((x): x is RouteChain => x !== null);

      const route: TokenRoute = { base: key, cgId: t.id, name: t.name, chains, updatedAt: Date.now() };
      db().tokens[key] = route;
      persist();
      return route;
    } catch {
      return null; // 저장하지 않는다 → 다음 기회에 재시도
    } finally {
      g.__arbRouteBuild!.delete(key);
    }
  })();
  g.__arbRouteBuild!.set(key, p);
  return p;
}

/** 풀 유동성만 배경 갱신(1h). 표시·1차 필터용이며 실행 판단의 단독 근거가 아니다. */
export function refreshLiquidity(base: string): Promise<void> {
  const key = base.toUpperCase();
  const running = g.__arbRouteLiq!.get(key);
  if (running) return running;

  const r = db().tokens[key];
  const stale = (r?.chains ?? []).filter((c) => !c.liquidityAt || Date.now() - c.liquidityAt > LIQ_TTL);
  if (!stale.length) return Promise.resolve();

  const p = (async () => {
    try {
      await Promise.all(stale.map(async (c) => {
        const pair = await topPair(c.chain, c.contract);
        if (!pair) return;
        c.pairAddress = pair.pairAddress;
        c.liquidityUsd = pair.liquidityUsd;
        c.liquidityAt = Date.now();
      }));
      persist();
    } catch {
      /* 유동성 갱신 실패는 무해 — 다음 호출에 다시 시도 */
    } finally {
      g.__arbRouteLiq!.delete(key);
    }
  })();
  g.__arbRouteLiq!.set(key, p);
  return p;
}

/**
 * 다른 경로에서 이미 조회한 풀 정보를 DB에 되먹인다. 호출부가 저장소를 직접
 * 만지지 않고도 캐시를 최신으로 유지하기 위한 유일한 쓰기 통로다.
 */
export function noteLiquidity(base: string, chain: string, pair: { pairAddress: string; liquidityUsd: number }): void {
  const c = db().tokens[base.toUpperCase()]?.chains.find((x) => x.chain === chain);
  if (!c) return;
  c.pairAddress = pair.pairAddress;
  c.liquidityUsd = pair.liquidityUsd;
  c.liquidityAt = Date.now();
  persist();
}

/**
 * 온체인 검증을 통과한 컨트랙트만 반환한다. 출금·전송처럼 되돌릴 수 없는 경로는
 * 반드시 이걸 쓴다 — 심볼이 같은 클론 토큰으로 자금이 나가는 걸 막는 지점이다.
 */
export function verifiedContract(base: string, chain: string): { address: string; decimals: number } | null {
  const c = getRoute(base)?.chains.find((x) => x.chain === chain);
  if (!c || c.trust !== "onchain") return null;
  if (Date.now() - c.verifiedAt > ROUTE_TTL) return null; // 재검증 필요
  return { address: c.contract, decimals: c.decimals };
}

/** 진단용 — SQLite 전환 임계 감시(docs/TOKEN_ROUTE_DB.md §9).
 *
 *  bytes는 **캐시된 값**이다. /api/health가 15초마다 폴링하는데 매번 전체를
 *  stringify하면, 임계(2MB) 근처에서 그 자체가 150ms 동기 정지를 만든다 —
 *  이벤트 루프 멈춤을 보고하려고 만든 엔드포인트가 멈춤을 유발하게 된다. */
let statsCache: { tokens: number; bytes: number; at: number } | null = null;
const STATS_TTL = 5 * 60_000;
export function routeDbStats(): { tokens: number; bytes: number } {
  const d = db();
  const tokens = Object.keys(d.tokens).length;
  if (!statsCache || Date.now() - statsCache.at > STATS_TTL || statsCache.tokens !== tokens) {
    statsCache = { tokens, bytes: JSON.stringify(d).length, at: Date.now() };
  }
  return { tokens, bytes: statsCache.bytes };
}
