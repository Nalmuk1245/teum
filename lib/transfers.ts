// Transfer/settlement status — per-coin deposit & withdrawal availability.
// This is the real gate on whether an edge is executable: if the coin's
// withdrawal is off on the buy venue, or deposit is off on the sell venue, the
// leg can't settle no matter how big the premium.
//
// Data sources:
//   • Bithumb — PUBLIC (/public/assetsstatus/ALL), always on.
//   • Upbit   — SIGNED (/v1/status/wallet, JWT). Needs UPBIT_KEY/SECRET.
//   • Binance — SIGNED (/sapi/v1/capital/config/getall, HMAC). Needs BINANCE_KEY/SECRET.
//   • Bybit   — SIGNED (/v5/asset/coin/query-info, HMAC). Needs BYBIT_KEY/SECRET.
//   • OKX     — SIGNED (/api/v5/asset/currencies, HMAC+passphrase). Needs OKX_* keys.
//
// The signed calls are FULLY WIRED but dormant: with no keys in env they return
// null (surfaced as "키 필요"). Drop keys into .env.local and they light up — no
// code change needed. Server-only module (uses node crypto); imported by the
// scanner which runs in the /api/scan route.

import crypto from "crypto";
import type { TransferStatus, Venue, WalletStatus } from "./types";
import { BINANCE_NET, chainKeyFromLabel } from "./chains";
import { COIN_NETWORK, COIN_NETWORK_DEFAULT } from "./config";
import { setLiveNetwork } from "./networks";

// ── 네트워크(체인)별 상세 ─────────────────────────────────────────────────────
// 거래소 응답에는 체인별 입출금 상태가 이미 들어 있는데, 코인 한 줄로 접으면서
// 버리고 있었다. "ETH는 열렸는데 BSC는 막힘" 같은 정보가 곧 전송 경로 선택이므로
// 같은 스윕에서 보존한다 — 추가 API 호출은 없다.
export type NetDetail = {
  net: string;            // 거래소가 부르는 체인 이름 (ETH, BSC, TRC20, …)
  deposit: boolean;
  withdraw: boolean;
  feeCoin?: number;       // 출금 수수료 (코인 단위) — 주는 거래소만
  isDefault?: boolean;    // 그 거래소의 기본 체인
};
type NetsByVenue = Partial<Record<Venue, NetDetail[]>>;
const gn = globalThis as unknown as {
  __arbGateNets?: Map<string, NetsByVenue>;
  /** 거래소별 마지막 성공 스윕 시각 — 키가 죽으면 상세가 낡는데, 시각이 없으면
   *  몇 시간 전 withdraw:true를 현재값처럼 서빙하게 된다 (감사 R8). */
  __arbGateNetsAt?: Partial<Record<Venue, number>>;
};
gn.__arbGateNets ??= new Map();
gn.__arbGateNetsAt ??= {};

/** 스윕이 채운 코인별 체인 상세 + 거래소별 채집 시각. 키 없는 거래소는 항목 자체가 없다. */
export function gateNetworks(base: string): { nets: NetsByVenue; fetchedAt: Partial<Record<Venue, number>> } {
  return { nets: gn.__arbGateNets!.get(base.toUpperCase()) ?? {}, fetchedAt: { ...gn.__arbGateNetsAt } };
}

function putNets(venue: Venue, base: string, nets: NetDetail[]): void {
  if (!nets.length) return;
  const m = gn.__arbGateNets!;
  const e = m.get(base) ?? {};
  e[venue] = nets;
  m.set(base, e);
  gn.__arbGateNetsAt![venue] = Date.now();
}

// ── Bithumb (public) ──────────────────────────────────────────────────────────
async function fetchBithumb(): Promise<Map<string, WalletStatus>> {
  const m = new Map<string, WalletStatus>();
  try {
    const res = await fetch("https://api.bithumb.com/public/assetsstatus/ALL", {
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as {
      status: string;
      data?: Record<string, { deposit_status: number; withdrawal_status: number }>;
    };
    if (j.status === "0000" && j.data) {
      for (const [base, v] of Object.entries(j.data)) {
        m.set(base, {
          deposit: v.deposit_status === 1,
          withdraw: v.withdrawal_status === 1,
        });
      }
    }
  } catch {
    /* network */
  }
  return m;
}

// ── Upbit (signed, JWT) ───────────────────────────────────────────────────────
function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// HS256 JWT with { access_key, nonce } — Upbit's auth for param-less endpoints.
function upbitJwt(accessKey: string, secretKey: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ access_key: accessKey, nonce: crypto.randomUUID() }));
  const sig = crypto.createHmac("sha256", secretKey).update(`${header}.${payload}`).digest();
  return `${header}.${payload}.${b64url(sig)}`;
}

async function fetchUpbit(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.UPBIT_KEY;
  const secret = process.env.UPBIT_SECRET;
  if (!key || !secret) return null; // dormant until keys added
  try {
    const res = await fetch("https://api.upbit.com/v1/status/wallet", {
      headers: { Authorization: `Bearer ${upbitJwt(key, secret)}` },
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const arr = (await res.json()) as Array<{ currency: string; wallet_state: string; net_type?: string | null }>;
    if (!Array.isArray(arr)) return null;
    const m = new Map<string, WalletStatus>();
    const nets = new Map<string, NetDetail[]>();
    for (const x of arr) {
      const s = x.wallet_state; // working | withdraw_only | deposit_only | paused | unsupported
      const st = {
        deposit: s === "working" || s === "deposit_only",
        withdraw: s === "working" || s === "withdraw_only",
      };
      const list = nets.get(x.currency) ?? [];
      list.push({ net: x.net_type || x.currency, ...st });
      nets.set(x.currency, list);
    }
    // 코인 요약은 **우리가 실제로 쓸 체인**의 행으로 정한다. OR로 접으면 "어느 한
    // 체인이라도 열림"이 되어 게이트가 단조 완화되는데, 이 값이 executable을 만들고
    // 거기서 실제 출금이 나간다 — TRX가 정지인데 ETH가 열려 있으면 통과시킨 뒤
    // TRX로 보내 미입금으로 좌초한다. 나머지 3개 거래소가 이미 이 방식이다
    // (fetchBinance/fetchBybit/fetchOkx). 목표 체인 행이 없을 때만 OR로 내려간다.
    for (const [base, list] of nets) {
      putNets("upbit", base, list);
      const wanted = BINANCE_NET[wantedChainKey(base)];
      const hit = wanted ? list.find((n) => n.net.toUpperCase() === wanted.toUpperCase()) : undefined;
      m.set(base, hit
        ? { deposit: hit.deposit, withdraw: hit.withdraw }
        : { deposit: list.some((n) => n.deposit), withdraw: list.some((n) => n.withdraw) });
    }
    return m;
  } catch {
    return null;
  }
}

// ── Binance (signed, HMAC-SHA256) ─────────────────────────────────────────────
async function fetchBinance(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.BINANCE_KEY;
  const secret = process.env.BINANCE_SECRET;
  if (!key || !secret) return null; // dormant until keys added
  try {
    const query = `recvWindow=5000&timestamp=${Date.now()}`;
    const sig = crypto.createHmac("sha256", secret).update(query).digest("hex");
    const res = await fetch(
      `https://api.binance.com/sapi/v1/capital/config/getall?${query}&signature=${sig}`,
      { headers: { "X-MBX-APIKEY": key }, cache: "no-store", signal: AbortSignal.timeout(10_000) },
    );
    const arr = (await res.json()) as Array<{
      coin: string;
      depositAllEnable: boolean;
      withdrawAllEnable: boolean;
      networkList?: Array<{ network: string; name?: string; isDefault?: boolean; depositEnable: boolean; withdrawEnable: boolean; withdrawFee?: string; withdrawMin?: string; minConfirm?: number }>;
    }>;
    if (!Array.isArray(arr)) return null;
    const m = new Map<string, WalletStatus>();
    for (const c of arr) {
      // Per-network gate: the coin-level flags say "some network works", but we
      // transfer on ONE specific chain (COIN_NETWORK) — if that chain is
      // suspended while another is up, coin-level would greenlight a trade that
      // strands at the withdraw step. Match our chain's networkList entry.
      const chainKey = chainKeyFromLabel((COIN_NETWORK[c.coin] ?? COIN_NETWORK_DEFAULT).chain);
      const wanted = BINANCE_NET[chainKey];
      const net = (wanted ? c.networkList?.find((n) => n.network === wanted) : undefined)
        ?? c.networkList?.find((n) => n.isDefault);
      m.set(c.coin, net
        ? { deposit: !!net.depositEnable, withdraw: !!net.withdrawEnable }
        : { deposit: !!c.depositAllEnable, withdraw: !!c.withdrawAllEnable });
      putNets("binance", c.coin, (c.networkList ?? []).map((n) => ({
        net: n.network, deposit: !!n.depositEnable, withdraw: !!n.withdrawEnable,
        feeCoin: n.withdrawFee ? Number(n.withdrawFee) : undefined, isDefault: !!n.isDefault,
      })));
      // Feed the LIVE network facts (chain label, confirms, fee) so strategies +
      // the depth quote use real values instead of the curated tables.
      if (net) {
        setLiveNetwork(c.coin, {
          chain: net.name || (COIN_NETWORK[c.coin] ?? COIN_NETWORK_DEFAULT).chain,
          confirms: net.minConfirm ?? (COIN_NETWORK[c.coin] ?? COIN_NETWORK_DEFAULT).confirms,
          withdrawFee: net.withdrawFee ? Number(net.withdrawFee) : 0,
          withdrawMin: net.withdrawMin ? Number(net.withdrawMin) : undefined,
        });
      }
    }
    return m;
  } catch {
    return null;
  }
}

// The transfer chain we'd actually use for a coin (same choice fetchBinance
// makes) — per-network gates must look at THIS chain, not "any chain works".
const wantedChainKey = (coin: string) =>
  chainKeyFromLabel((COIN_NETWORK[coin] ?? COIN_NETWORK_DEFAULT).chain);

// ── Bybit (signed, HMAC-SHA256) ───────────────────────────────────────────────
// Bybit's chain codes largely coincide with Binance's (ETH/BSC/TRX/SOL/XRP…),
// so BINANCE_NET doubles as the match key. No coin-level flags exist — when our
// chain isn't listed, OR across chains (= Binance's coin-level fallback).
async function fetchBybit(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.BYBIT_KEY;
  const secret = process.env.BYBIT_SECRET;
  if (!key || !secret) return null; // dormant until keys added
  try {
    const ts = String(Date.now()), recv = "5000", query = "";
    const sig = crypto.createHmac("sha256", secret).update(ts + key + recv + query).digest("hex");
    const res = await fetch("https://api.bybit.com/v5/asset/coin/query-info", {
      headers: { "X-BAPI-API-KEY": key, "X-BAPI-TIMESTAMP": ts, "X-BAPI-RECV-WINDOW": recv, "X-BAPI-SIGN": sig },
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as {
      retCode: number;
      result?: { rows?: Array<{ coin: string; chains?: Array<{ chain: string; chainDeposit: string; chainWithdraw: string }> }> };
    };
    if (j.retCode !== 0 || !j.result?.rows) return null;
    const m = new Map<string, WalletStatus>();
    for (const r of j.result.rows) {
      const chains = r.chains ?? [];
      if (!chains.length) continue;
      const wanted = BINANCE_NET[wantedChainKey(r.coin)];
      const net = wanted ? chains.find((c) => c.chain?.toUpperCase() === wanted.toUpperCase()) : undefined;
      m.set(r.coin, net
        ? { deposit: net.chainDeposit === "1", withdraw: net.chainWithdraw === "1" }
        : {
            deposit: chains.some((c) => c.chainDeposit === "1"),
            withdraw: chains.some((c) => c.chainWithdraw === "1"),
          });
      putNets("bybit", r.coin, chains.map((c) => ({
        net: c.chain, deposit: c.chainDeposit === "1", withdraw: c.chainWithdraw === "1",
      })));
    }
    return m;
  } catch {
    return null;
  }
}

// ── OKX (signed, HMAC-SHA256 + passphrase) ────────────────────────────────────
// OKX names chains "CCY-Network" (USDT-ERC20, SOL-Solana…) — map our chain key
// to its network word and substring-match, same tolerance as okxDeposit.
const OKX_NET: Record<string, string> = {
  ethereum: "ERC20", bsc: "BEP20", tron: "TRC20", solana: "Solana",
  xrp: "XRP", polygon: "Polygon", arbitrum: "Arbitrum", optimism: "Optimism",
  base: "Base", avalanche: "Avalanche",
};
async function fetchOkx(): Promise<Map<string, WalletStatus> | null> {
  const key = process.env.OKX_KEY;
  const secret = process.env.OKX_SECRET;
  const pass = process.env.OKX_PASSPHRASE;
  if (!key || !secret || !pass) return null; // dormant until keys added
  try {
    const path = "/api/v5/asset/currencies";
    const ts = new Date().toISOString();
    const sig = crypto.createHmac("sha256", secret).update(ts + "GET" + path).digest("base64");
    const res = await fetch(`https://www.okx.com${path}`, {
      headers: { "OK-ACCESS-KEY": key, "OK-ACCESS-SIGN": sig, "OK-ACCESS-TIMESTAMP": ts, "OK-ACCESS-PASSPHRASE": pass },
      cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as {
      code: string;
      data?: Array<{ ccy: string; chain?: string; canDep: boolean; canWd: boolean }>;
    };
    if (j.code !== "0" || !j.data) return null;
    // Group rows (one per chain) by coin, then pick our chain / OR-fallback.
    const byCoin = new Map<string, Array<{ chain?: string; canDep: boolean; canWd: boolean }>>();
    for (const d of j.data) {
      const arr = byCoin.get(d.ccy) ?? [];
      arr.push(d);
      byCoin.set(d.ccy, arr);
    }
    const m = new Map<string, WalletStatus>();
    for (const [coin, rows] of byCoin) {
      const wanted = OKX_NET[wantedChainKey(coin)];
      const net = wanted
        ? rows.find((r) => r.chain?.toUpperCase().includes(wanted.toUpperCase()))
        : undefined;
      m.set(coin, net
        ? { deposit: !!net.canDep, withdraw: !!net.canWd }
        : { deposit: rows.some((r) => r.canDep), withdraw: rows.some((r) => r.canWd) });
      putNets("okx", coin, rows.map((r) => ({
        // OKX 체인명은 "USDT-ERC20" 꼴 — 코인 접두는 떼고 네트워크만 남긴다.
        net: r.chain ? r.chain.replace(`${coin}-`, "") : coin,
        deposit: !!r.canDep, withdraw: !!r.canWd,
      })));
    }
    return m;
  } catch {
    return null;
  }
}

// ── Aggregate ─────────────────────────────────────────────────────────────────
export async function fetchTransferStatus(): Promise<TransferStatus> {
  const [bithumb, upbit, binance, bybit, okx] = await Promise.all([
    fetchBithumb(),
    fetchUpbit(),
    fetchBinance(),
    fetchBybit(),
    fetchOkx(),
  ]);
  const byVenue: TransferStatus["byVenue"] = { bithumb };
  if (upbit) byVenue.upbit = upbit;
  if (binance) byVenue.binance = binance;
  if (bybit) byVenue.bybit = bybit;
  if (okx) byVenue.okx = okx;
  return { byVenue };
}

/** Wallet status for a coin on a venue, or null when unknown (no keys / not listed). */
export function walletStatus(
  ts: TransferStatus | undefined,
  venue: Venue,
  base: string,
): WalletStatus | null {
  return ts?.byVenue[venue]?.get(base) ?? null;
}
