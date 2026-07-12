// Multi-chain registry. Maps a coin's transfer network to a concrete chain
// (family + RPC + native asset) used by both the wallet sender and the
// personal-wallet balance reader. RPCs default to public nodes; override via env.

export type ChainFamily = "evm" | "xrp" | "tron" | "solana";

export type ChainInfo = {
  key: string;
  family: ChainFamily;
  label: string;
  native: string; // native asset symbol (for USD valuation)
  evmChainId?: number;
  rpc: string;
  explorer?: string;
};

const env = (k: string, d: string) => process.env[k] || d;

export const CHAINS: Record<string, ChainInfo> = {
  ethereum: { key: "ethereum", family: "evm", label: "Ethereum", native: "ETH", evmChainId: 1, rpc: env("WALLET_RPC_ETHEREUM", "https://eth.llamarpc.com"), explorer: "https://etherscan.io/tx/" },
  polygon: { key: "polygon", family: "evm", label: "Polygon", native: "POL", evmChainId: 137, rpc: env("WALLET_RPC_POLYGON", "https://polygon-rpc.com"), explorer: "https://polygonscan.com/tx/" },
  arbitrum: { key: "arbitrum", family: "evm", label: "Arbitrum One", native: "ETH", evmChainId: 42161, rpc: env("WALLET_RPC_ARBITRUM", "https://arb1.arbitrum.io/rpc"), explorer: "https://arbiscan.io/tx/" },
  optimism: { key: "optimism", family: "evm", label: "Optimism", native: "ETH", evmChainId: 10, rpc: env("WALLET_RPC_OPTIMISM", "https://mainnet.optimism.io"), explorer: "https://optimistic.etherscan.io/tx/" },
  base: { key: "base", family: "evm", label: "Base", native: "ETH", evmChainId: 8453, rpc: env("WALLET_RPC_BASE", "https://mainnet.base.org"), explorer: "https://basescan.org/tx/" },
  bsc: { key: "bsc", family: "evm", label: "BNB Chain", native: "BNB", evmChainId: 56, rpc: env("WALLET_RPC_BSC", "https://bsc-dataseed.binance.org"), explorer: "https://bscscan.com/tx/" },
  avalanche: { key: "avalanche", family: "evm", label: "Avalanche C", native: "AVAX", evmChainId: 43114, rpc: env("WALLET_RPC_AVAX", "https://api.avax.network/ext/bc/C/rpc"), explorer: "https://snowtrace.io/tx/" },
  xrp: { key: "xrp", family: "xrp", label: "XRP Ledger", native: "XRP", rpc: env("WALLET_RPC_XRP", "https://s1.ripple.com:51234/"), explorer: "https://livenet.xrpl.org/transactions/" },
  tron: { key: "tron", family: "tron", label: "Tron", native: "TRX", rpc: env("WALLET_RPC_TRON", "https://api.trongrid.io"), explorer: "https://tronscan.org/#/transaction/" },
  solana: { key: "solana", family: "solana", label: "Solana", native: "SOL", rpc: env("WALLET_RPC_SOLANA", "https://api.mainnet-beta.solana.com"), explorer: "https://solscan.io/tx/" },
};

/** Resolve a display chain label (from COIN_NETWORK) to a chain key. */
export function chainKeyFromLabel(label?: string): string {
  const s = (label || "").toLowerCase();
  if (s.includes("polygon")) return "polygon";
  if (s.includes("arbitrum")) return "arbitrum";
  if (s.includes("optimism")) return "optimism";
  if (s.includes("base")) return "base";
  if (s.includes("bnb") || s.includes("bsc")) return "bsc";
  if (s.includes("avalanche")) return "avalanche";
  if (s.includes("xrp")) return "xrp";
  if (s.includes("tron") || s.includes("trc20")) return "tron";
  if (s.includes("solana")) return "solana";
  if (s.includes("ethereum") || s.includes("erc20")) return "ethereum";
  return ""; // unknown
}

export const getChain = (key: string): ChainInfo | undefined => CHAINS[key];
