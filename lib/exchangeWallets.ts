// Exchange wallet address book — which on-chain addresses belong to which CEX,
// hot vs cold. Used by the listing play to read "how much of token X can flow
// into Upbit right now" straight from chain state (no Arkham/Nansen needed —
// labels are static, balances come from RPC).
//
// Sources, in merge order (later wins on duplicate address):
//  1. SEED — a small set of very-well-known labeled wallets (hardcoded).
//  2. data/exchange-wallets.json — local, user-editable. Populated by the
//     one-time Etherscan-label import (운영 탭 → 라벨 가져오기) and/or by hand
//     from Arkham's web UI (hot/cold is visible there; set "type" accordingly).
//
// EVM addresses are chain-agnostic: the same address book is queried on
// ethereum/bsc/base. Non-EVM chains are out of scope (v1).

import { promises as fs, existsSync, readFileSync } from "fs";
import path from "path";

export type WalletType = "hot" | "cold";
export type WalletEntry = { address: string; type: WalletType; tag?: string };
export type VenueWallets = Record<string, WalletEntry[]>;

const FILE = path.join(process.cwd(), "data", "exchange-wallets.json");

// Very-well-known Etherscan labels only — everything else comes from the
// import (guessing addresses from memory is how you get wrong signals).
const SEED: VenueWallets = {
  binance: [
    { address: "0x28C6c06298d514Db089934071355E5743bf21d60", type: "hot", tag: "Binance 14" },
    { address: "0x21a31Ee1afC51d94C2eFcCAa2092aD1028285549", type: "hot", tag: "Binance 15" },
    { address: "0xDFd5293D8e347dFe59E90eFd55b2956a1343963d", type: "hot", tag: "Binance 16" },
    { address: "0xF977814e90dA44bFA03b6295A0616a897441aceC", type: "cold", tag: "Binance 8 (cold)" },
    { address: "0xBE0eB53F46cd790Cd13851d5EFf43D12404d33E8", type: "cold", tag: "Binance 7 (cold)" },
    // BSC-native hot wallets (still just EVM addresses)
    { address: "0x8894E0a0c962CB723c1976a4421c95949bE2D4E3", type: "hot", tag: "Binance BSC hot 6" },
    { address: "0xe2fc31F816A9b94326492132018C3aEcC4a93aE1", type: "hot", tag: "Binance BSC hot" },
  ],
  okx: [
    { address: "0x6cC5F688a315f3dC28A7781717a9A798a59fDA7b", type: "hot", tag: "OKX" },
  ],
  bybit: [
    { address: "0xf89d7b9c864f589bbF53a82105107622B35EaA40", type: "cold", tag: "Bybit cold" },
  ],
  upbit: [
    { address: "0x390dE26d772D2e2005C6d1d24afC902bae37a4bB", type: "cold", tag: "Upbit" },
  ],
  bithumb: [],
};

type CacheT = { ts: number; book: VenueWallets };
const g = globalThis as unknown as { __arbWalletBook?: CacheT };

/** Merged address book (seed + local file). Cached 60s. */
export function loadWalletBook(): VenueWallets {
  if (g.__arbWalletBook && Date.now() - g.__arbWalletBook.ts < 60_000) return g.__arbWalletBook.book;
  const book: VenueWallets = {};
  const put = (venue: string, e: WalletEntry) => {
    const list = (book[venue] ??= []);
    const i = list.findIndex((x) => x.address.toLowerCase() === e.address.toLowerCase());
    if (i >= 0) list[i] = e; else list.push(e);
  };
  try {
    if (existsSync(FILE)) {
      const local = JSON.parse(readFileSync(FILE, "utf8")) as VenueWallets;
      for (const [v, list] of Object.entries(local)) for (const e of list) if (e?.address) put(v, e);
    }
  } catch { /* malformed file → seed only */ }
  // Seed LAST — it carries hand-verified hot/cold types (Etherscan tags don't
  // say "cold", so the import defaults everything to hot).
  for (const [v, list] of Object.entries(SEED)) for (const e of list) put(v, e);
  g.__arbWalletBook = { ts: Date.now(), book };
  return book;
}

export function walletBookStats(): Record<string, { hot: number; cold: number }> {
  const out: Record<string, { hot: number; cold: number }> = {};
  for (const [v, list] of Object.entries(loadWalletBook())) {
    out[v] = { hot: list.filter((e) => e.type === "hot").length, cold: list.filter((e) => e.type === "cold").length };
  }
  return out;
}

// ── One-time import from the public Etherscan label dump ──────────────────────
// github.com/dawsbot/eth-labels → data/json/accounts.json (~22MB). We filter
// name tags per venue and classify hot/cold from the tag text (Etherscan tags
// rarely say "cold" — refine by hand from Arkham web afterwards if needed).

const LABELS_URL =
  "https://raw.githubusercontent.com/dawsbot/eth-labels/v1/data/json/accounts.json";

const VENUE_RE: Record<string, RegExp> = {
  binance: /^binance(?!.*(us|\.us))/i,
  upbit: /^upbit/i,
  bithumb: /^bithumb/i,
  okx: /^(okx|okex)/i,
  bybit: /^bybit/i,
};

// Real treasury wallets only — "Binance 14", "OKX: Hot Wallet 3", "Upbit 2".
// The dump also labels thousands of misc addresses ("Binance: Deposit Funder",
// charity, US entity…) that would bloat the multicall and skew nothing but
// noise; keep the tag shape strict.
const MAIN_WALLET_RE =
  /^(binance|upbit|bithumb|okx|okex|bybit)(\.com)?:?\s*((hot|cold)\s*wallet)?\s*\d*$/i;

export async function importFromEthLabels(): Promise<Record<string, number> | { error: string }> {
  let rows: unknown[];
  try {
    const res = await fetch(LABELS_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return { error: `label dump HTTP ${res.status}` };
    rows = (await res.json()) as unknown[];
  } catch (e) {
    return { error: e instanceof Error ? e.message : "다운로드 실패" };
  }
  const out: VenueWallets = {};
  for (const r of rows) {
    // Dump rows: { address, chainId, label: "binance", nameTag: "Binance 14" }
    const o = r as { address?: string; nameTag?: string; label?: string };
    const addr = o.address;
    const tag = o.nameTag || o.label || "";
    if (!addr || !/^0x[0-9a-fA-F]{40}$/.test(addr) || !tag) continue;
    if (!MAIN_WALLET_RE.test(tag)) continue;
    for (const [venue, re] of Object.entries(VENUE_RE)) {
      if (!re.test(tag)) continue;
      (out[venue] ??= []).push({ address: addr, type: /cold/i.test(tag) ? "cold" : "hot", tag });
      break;
    }
  }
  // Imported venues are REPLACED wholesale (re-import stays clean); hand-added
  // entries should live in venues the import doesn't touch, or in SEED.
  let existing: VenueWallets = {};
  try {
    if (existsSync(FILE)) existing = JSON.parse(readFileSync(FILE, "utf8")) as VenueWallets;
  } catch { /* start fresh */ }
  for (const [v, list] of Object.entries(out)) existing[v] = list;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(existing, null, 2), "utf8");
  g.__arbWalletBook = undefined; // bust cache
  const counts: Record<string, number> = {};
  for (const [v, list] of Object.entries(existing)) counts[v] = list.length;
  return counts;
}
