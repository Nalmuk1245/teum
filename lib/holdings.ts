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
  hotDeltaPerMin: number | null; // token units/min since last snapshot
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

type Snap = { ts: number; hotByVenue: Record<string, number> };
const g = globalThis as unknown as {
  __arbHoldingsCache?: Map<string, { ts: number; v: HoldingsResult }>;
  __arbHoldingsPrev?: Map<string, Snap>;
};
g.__arbHoldingsCache ??= new Map();
g.__arbHoldingsPrev ??= new Map();
const CACHE = g.__arbHoldingsCache;
const PREV = g.__arbHoldingsPrev;
const TTL = 60_000;

export async function fetchHoldings(symbolRaw: string): Promise<HoldingsResult | { error: string }> {
  const symbol = symbolRaw.toUpperCase();
  const hit = CACHE.get(symbol);
  if (hit && Date.now() - hit.ts < TTL) return hit.v;

  const token = await resolveToken(symbol);
  if (!token) return { error: `${symbol}: CoinGecko에서 못 찾음 (오타/미등록)` };
  const chains = QUERY_CHAINS.filter((c) => token.contracts[c]);
  if (!chains.length) {
    return { error: `${symbol}(${token.name}): EVM(ETH/BSC/Base) 컨트랙트 없음 — 비EVM 체인은 v1 미지원` };
  }

  const book = loadWalletBook();
  // Flatten to one call list; remember (venue, type) per index.
  const flat: { venue: string; type: "hot" | "cold"; address: string }[] = [];
  for (const [venue, list] of Object.entries(book)) {
    for (const e of list) flat.push({ venue, type: e.type, address: e.address });
  }
  if (!flat.length) return { error: "주소록 비어있음 — 운영 탭에서 라벨 가져오기 먼저" };

  const sums = new Map<string, { hot: number; cold: number; n: number }>();
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
                bump(flat[base + i].venue, flat[base + i].type, Number(raw) / 10 ** c.decimals);
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
      const delta = prev && dtMin > 0.3 && dtMin < 30 && prev.hotByVenue[venue] != null
        ? (s.hot - prev.hotByVenue[venue]) / dtMin
        : null;
      return {
        venue, hot: s.hot, cold: s.cold,
        hotUsd: px != null ? s.hot * px : null,
        coldUsd: px != null ? s.cold * px : null,
        addresses: s.n, hotDeltaPerMin: delta,
      };
    })
    .sort((a, b) => (b.hot + b.cold) - (a.hot + a.cold));
  PREV.set(symbol, { ts: now, hotByVenue: Object.fromEntries(venues.map((v) => [v.venue, v.hot])) });

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
