// Binance USDT-M perpetual availability — decides whether a coin can be hedged
// (short the perp at spot-buy time to neutralize price risk during transfer).
// Public endpoint, no key.

export async function fetchPerpBases(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    // Timeout so a slow/blocked futures API can never stall the whole scan.
    const res = await fetch("https://fapi.binance.com/fapi/v1/exchangeInfo", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const j = (await res.json()) as {
      symbols?: Array<{
        contractType: string;
        status: string;
        baseAsset: string;
        quoteAsset: string;
      }>;
    };
    for (const s of j.symbols ?? []) {
      if (s.contractType === "PERPETUAL" && s.quoteAsset === "USDT" && s.status === "TRADING") {
        out.add(s.baseAsset);
      }
    }
  } catch {
    /* network — treat as unknown (empty) */
  }
  return out;
}
