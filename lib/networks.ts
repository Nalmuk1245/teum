// Live per-coin network facts (chain, deposit confirms, withdrawal fee) sourced
// from Binance's networkList — replaces the hand-curated tables when keys are
// set. transfers.ts populates the cache during its getall sweep; strategies and
// the depth quote read through these getters, falling back to config when a coin
// isn't in the live map (or no keys). globalThis so all route bundles share it.

import { COIN_NETWORK, COIN_NETWORK_DEFAULT, WITHDRAW_FEE_COIN } from "./config";

export type LiveNetwork = { chain: string; confirms: number; withdrawFee: number };
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
