// Token contract map for the personal-wallet transfer. Determines whether a
// coin sends as a chain-native asset or an ERC20/TRC20/SPL token (+ contract,
// decimals). Curated for common cases; unknown tokens are flagged so a wrong
// native send never happens silently. Extend as needed.

import { CHAINS } from "./chains";

type TokenInfo = { address: string; decimals: number };

// base → chainKey → contract. USDT/USDC across chains + a few majors.
const TOKENS: Record<string, Partial<Record<string, TokenInfo>>> = {
  USDT: {
    ethereum: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6 },
    tron: { address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6 },
    polygon: { address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6 },
  },
  USDC: {
    ethereum: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", decimals: 6 },
    polygon: { address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", decimals: 6 },
  },
  LINK: { ethereum: { address: "0x514910771AF9Ca656af840dff83E8264EcF986CA", decimals: 18 } },
  UNI: { ethereum: { address: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", decimals: 18 } },
  PEPE: { ethereum: { address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933", decimals: 18 } },
  SHIB: { ethereum: { address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE", decimals: 18 } },
  ARB: { arbitrum: { address: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18 } },
};

export type WalletAsset =
  | { kind: "native"; known: true }
  | { kind: "token"; known: true; address: string; decimals: number }
  | { kind: "unknown"; known: false };

/** How to send `base` on `chainKey`: native, a known token, or unknown. */
export function tokenFor(base: string, chainKey: string): WalletAsset {
  const chain = CHAINS[chainKey];
  if (chain && base === chain.native) return { kind: "native", known: true };
  const t = TOKENS[base]?.[chainKey];
  if (t) return { kind: "token", known: true, address: t.address, decimals: t.decimals };
  return { kind: "unknown", known: false };
}
