// Exchange on-chain holdings of one token — the listing-play supply signal.
// Multicall3 batches balanceOf(every exchange address) into one RPC call per
// chain, so a full 5-venue sweep is 3 RPC calls and sub-second.
//
// Reading: global-CEX HOT balances = supply that can hit Upbit within minutes
// of a listing (arb sellers). Cold = exists but hours away. hotDeltaPerMin
// (vs the previous snapshot) shows live in/outflow while the play is running.

import { Contract, Interface, JsonRpcProvider } from "ethers";
import { CHAINS } from "./chains";
import { loadWalletBook } from "./exchangeWallets";
import { resolveToken } from "./tokenResolve";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11"; // same on all EVM chains
const MC_ABI = [
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
];
const ERC20 = new Interface(["function balanceOf(address) view returns (uint256)"]);

export type VenueHolding = {
  venue: string;
  hot: number; // token units
  cold: number;
  hotUsd: number | null;
  coldUsd: number | null;
  addresses: number; // how many were queried (coverage indicator)
  hotDeltaPerMin: number | null; // token units/min since last snapshot (순)
  hotInPerMin: number | null;    // 유입 (주소별 증가분 합) token units/min
  hotOutPerMin: number | null;   // 유출 (주소별 감소분 합) token units/min
  breakdown?: WalletBreak[]; // 주소별 잔고 드릴다운 (0 초과만, USD순)
};

export type WalletBreak = {
  address: string;
  tag: string | null; // 라벨 (예: "Binance 14"), 없으면 null
  type: "hot" | "cold";
  amount: number;
  usd: number | null;
};

export type HoldingsResult = {
  symbol: string;
  name: string;
  priceUsd: number | null;
  volumeUsd: number | null;
  chains: string[]; // chains actually queried
  venues: VenueHolding[];
  /** Σ global-CEX hot balances in USD — the "can dump on Upbit now" number. */
  globalHotUsd: number | null;
  /** globalHotUsd / 24h volume — big ⇒ pump likely short-lived. */
  dumpRatioPct: number | null;
  updatedAt: number;
  note?: string;
};

const KR_VENUES = new Set(["upbit", "bithumb"]);
const QUERY_CHAINS = ["ethereum", "bsc", "base"] as const;

type Snap = {
  ts: number;
  hotByVenue: Record<string, number>;
  /** 거래소별 핫 주소 잔고 — 순 Δ가 아니라 유입/유출을 가르려면 주소 단위가
   *  필요하다 (같은 분에 +10k 입금과 −8k 출금이 있으면 순은 +2k뿐이라
   *  "덤핑 재고가 들어오는 중"이라는 신호가 뭉개진다). */
  hotAddr: Record<string, Record<string, number>>;
};
const g = globalThis as unknown as {
  __arbHoldingsCache?: Map<string, { ts: number; v: HoldingsResult }>;
  __arbHoldingsPrev?: Map<string, Snap>;
};
g.__arbHoldingsCache ??= new Map();
g.__arbHoldingsPrev ??= new Map();
const CACHE = g.__arbHoldingsCache;
const PREV = g.__arbHoldingsPrev;
const TTL = 60_000;

// ── 절대 기다리게 하지 않는 조회 ──────────────────────────────────────────────
// 이 조회는 체인 3개 × 주소록 전체 RPC라 실측 14초다. 그걸 요청 연결을 잡은 채
// 기다리게 하면 브라우저의 동일 서버 6연결 한도를 하나 차지하고, 상세 패널의
// 다른 요청(listing-detail)이 그 뒤에 줄을 선다 — "조회 3.8초"의 정체가 이거였다.
// 그래서 API는 이 함수만 쓴다: 있으면(낡았어도) 즉시 주고 뒤에서 갱신, 없으면
// pending을 즉시 주고 뒤에서 구축한다. 연결은 어느 경우에도 ms 안에 풀린다.
const gi = globalThis as unknown as {
  __arbHoldingsInflight?: Map<string, Promise<unknown>>;
  // fetchHoldings는 성공만 CACHE에 넣는다. 에러를 안 기억하면 에러 심볼은
  // pending이 영원히 반복되며 14초 작업을 계속 다시 돈다 — 짧게만 기억한다.
  __arbHoldingsErr?: Map<string, { ts: number; error: string }>;
};
gi.__arbHoldingsInflight ??= new Map();
gi.__arbHoldingsErr ??= new Map();
const ERR_TTL = 60_000;

export function peekHoldings(symbol: string): { v: HoldingsResult | { error: string } | null; pending: boolean } {
  const key = symbol.toUpperCase();
  const hit = CACHE.get(key);
  const err = gi.__arbHoldingsErr!.get(key);
  const fresh = (hit && Date.now() - hit.ts < TTL) || (err && Date.now() - err.ts < ERR_TTL);
  if (!fresh && !gi.__arbHoldingsInflight!.has(key)) {
    const p = fetchHoldings(key, { fresh: true })
      .then((r) => { if ("error" in r) gi.__arbHoldingsErr!.set(key, { ts: Date.now(), error: r.error }); })
      // reject도 메모한다 — 안 남기면 pending이 계속 참이라 클라이언트 3초
      // 재시도가 14초짜리 스윕을 매번 새로 지폈다 (감사 R6).
      .catch((e) => gi.__arbHoldingsErr!.set(key, { ts: Date.now(), error: e instanceof Error ? e.message : "조회 실패" }))
      .finally(() => gi.__arbHoldingsInflight!.delete(key));
    gi.__arbHoldingsInflight!.set(key, p);
  }
  if (hit) return { v: hit.v, pending: false }; // 낡은 값도 값이다 — 뒤에서 갱신 중
  if (err && Date.now() - err.ts < ERR_TTL) return { v: { error: err.error }, pending: false };
  return { v: null, pending: true };
}

export async function fetchHoldings(symbolRaw: string, opts?: { fresh?: boolean }): Promise<HoldingsResult | { error: string }> {
  const symbol = symbolRaw.toUpperCase();
  const hit = CACHE.get(symbol);
  if (!opts?.fresh && hit && Date.now() - hit.ts < TTL) return hit.v;

  const token = await resolveToken(symbol);
  if (!token) return { error: `${symbol}: CoinGecko에서 못 찾음 (오타/미등록)` };
  const chains = QUERY_CHAINS.filter((c) => token.contracts[c]);
  if (!chains.length) {
    return { error: `${symbol}(${token.name}): EVM(ETH/BSC/Base) 컨트랙트 없음 — 비EVM 체인은 v1 미지원` };
  }

  const book = loadWalletBook();
  // Flatten to one call list; remember (venue, type) per index.
  const flat: { venue: string; type: "hot" | "cold"; address: string; tag: string | null }[] = [];
  for (const [venue, list] of Object.entries(book)) {
    for (const e of list) flat.push({ venue, type: e.type, address: e.address, tag: e.tag ?? null });
  }
  if (!flat.length) return { error: "주소록 비어있음 — 운영 탭에서 라벨 가져오기 먼저" };

  const sums = new Map<string, { hot: number; cold: number; n: number }>();
  // 주소별 잔고(여러 체인 합산) — 드릴다운용. key = 주소.
  const byAddr = new Map<string, { venue: string; type: "hot" | "cold"; tag: string | null; amount: number }>();
  const bump = (venue: string, type: "hot" | "cold", amt: number) => {
    const s = sums.get(venue) ?? { hot: 0, cold: 0, n: 0 };
    s[type] += amt;
    sums.set(venue, s);
  };
  for (const f of flat) { const s = sums.get(f.venue) ?? { hot: 0, cold: 0, n: 0 }; s.n++; sums.set(f.venue, s); }

  const queried: string[] = [];
  let failedBatches = 0;
  await Promise.all(chains.map(async (chainKey) => {
    const c = token.contracts[chainKey]!;
    const rpc = CHAINS[chainKey]?.rpc;
    if (!rpc) return;
    try {
      const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
      const mc = new Contract(MULTICALL3, MC_ABI, provider);
      const calls = flat.map((f) => ({
        target: c.address,
        allowFailure: true,
        callData: ERC20.encodeFunctionData("balanceOf", [f.address]),
      }));
      // Chunk so a single eth_call stays under public-RPC request/gas caps.
      const BATCH = 300;
      const batches: Promise<void>[] = [];
      for (let off = 0; off < calls.length; off += BATCH) {
        const slice = calls.slice(off, off + BATCH);
        const base = off;
        const attempt = () =>
          (mc.aggregate3.staticCall(slice) as Promise<{ success: boolean; returnData: string }[]>).then((res) => {
            res.forEach((r, i) => {
              if (!r.success || r.returnData === "0x") return;
              try {
                const raw = ERC20.decodeFunctionResult("balanceOf", r.returnData)[0] as bigint;
                const f = flat[base + i];
                const amt = Number(raw) / 10 ** c.decimals;
                bump(f.venue, f.type, amt);
                const a = byAddr.get(f.address) ?? { venue: f.venue, type: f.type, tag: f.tag, amount: 0 };
                a.amount += amt; // 같은 주소의 여러 체인 잔고 합산
                byAddr.set(f.address, a);
              } catch { /* bad return */ }
            });
          });
        batches.push(
          // aggregate3 is payable → must be staticCall'd or ethers tries to send
          // a tx. One retry, then count the batch as a coverage gap.
          attempt().catch(() => attempt()).catch(() => { failedBatches++; }),
        );
      }
      await Promise.all(batches);
      queried.push(chainKey);
    } catch { /* RPC down — skip chain */ }
  }));
  if (!queried.length) return { error: "모든 체인 RPC 실패 — 잠시 후 재시도" };

  const px = token.priceUsd;
  const prev = PREV.get(symbol);
  const now = Date.now();
  const venues: VenueHolding[] = [...sums.entries()]
    .map(([venue, s]) => {
      const dtMin = prev ? (now - prev.ts) / 60_000 : 0;
      const windowOk = prev != null && dtMin > 0.3 && dtMin < 30;
      const delta = windowOk && prev!.hotByVenue[venue] != null
        ? (s.hot - prev!.hotByVenue[venue]) / dtMin
        : null;
      // 유입/유출 분해 — 주소별 증감을 각각 합산. RPC 배치가 하나라도 실패한
      // 스윕은 건너뛴다: 누락 주소의 잔고가 "전량 유출"로 둔갑한다.
      let inflow: number | null = null, outflow: number | null = null;
      const prevAddr = prev?.hotAddr?.[venue];
      if (windowOk && prevAddr && failedBatches === 0) {
        let inn = 0, out = 0;
        const curAddr = new Map<string, number>();
        for (const [addr, a] of byAddr) if (a.venue === venue && a.type === "hot") curAddr.set(addr, a.amount);
        for (const [addr, cur] of curAddr) {
          const p0 = prevAddr[addr] ?? 0; // 신규 주소 = 전액 유입
          if (cur > p0) inn += cur - p0; else out += p0 - cur;
        }
        for (const [addr, p0] of Object.entries(prevAddr)) {
          if (!curAddr.has(addr)) out += p0; // 이번 스윕에 없는(0이 된) 주소 = 유출
        }
        inflow = inn / dtMin;
        outflow = out / dtMin;
      }
      const breakdown: WalletBreak[] = [...byAddr.entries()]
        .filter(([, a]) => a.venue === venue && a.amount > 0)
        .map(([address, a]) => ({ address, tag: a.tag, type: a.type, amount: a.amount, usd: px != null ? a.amount * px : null }))
        .sort((x, y) => (y.usd ?? y.amount) - (x.usd ?? x.amount))
        .slice(0, 15);
      return {
        venue, hot: s.hot, cold: s.cold,
        hotUsd: px != null ? s.hot * px : null,
        coldUsd: px != null ? s.cold * px : null,
        addresses: s.n, hotDeltaPerMin: delta, hotInPerMin: inflow, hotOutPerMin: outflow, breakdown,
      };
    })
    .sort((a, b) => (b.hot + b.cold) - (a.hot + a.cold));
  const hotAddrSnap: Record<string, Record<string, number>> = {};
  for (const [addr, a] of byAddr) {
    if (a.type !== "hot" || a.amount <= 0) continue;
    (hotAddrSnap[a.venue] ??= {})[addr] = a.amount;
  }
  PREV.set(symbol, { ts: now, hotByVenue: Object.fromEntries(venues.map((v) => [v.venue, v.hot])), hotAddr: hotAddrSnap });

  const globalHot = venues.filter((v) => !KR_VENUES.has(v.venue)).reduce((s, v) => s + v.hot, 0);
  const globalHotUsd = px != null ? globalHot * px : null;
  const dumpRatioPct = globalHotUsd != null && token.volumeUsd ? (globalHotUsd / token.volumeUsd) * 100 : null;

  const result: HoldingsResult = {
    symbol, name: token.name, priceUsd: px, volumeUsd: token.volumeUsd,
    chains: queried, venues, globalHotUsd, dumpRatioPct, updatedAt: now,
    note: failedBatches > 0
      ? `⚠ RPC 배치 ${failedBatches}건 실패 — 일부 주소 누락 가능 (재조회 권장)`
      : "표시 잔고는 라벨된 주소 합계 = 하한선 (미라벨 지갑 제외)",
  };
  CACHE.set(symbol, { ts: now, v: result });
  return result;
}

/** Compact one-liner for telegram alerts. */
export function holdingsSummaryText(h: HoldingsResult): string {
  const fmt = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : n.toFixed(0);
  const usd = (n: number | null) => (n != null ? `($${fmt(n)})` : "");
  const lines = h.venues
    .filter((v) => v.hot + v.cold > 0)
    .slice(0, 5)
    .map((v) => `${v.venue}: 핫 ${fmt(v.hot)}${usd(v.hotUsd)} · 콜드 ${fmt(v.cold)}`);
  const ratio = h.dumpRatioPct != null
    ? `\n즉시 유입가능/24h거래량 = ${h.dumpRatioPct.toFixed(0)}% ${h.dumpRatioPct > 50 ? "⚠ 덤핑 압력 큼" : "→ 압력 낮음"}`
    : "";
  return lines.length ? `거래소 보유량 (${h.chains.join("/")})\n${lines.join("\n")}${ratio}` : "라벨된 거래소 지갑에 잔고 없음";
}
