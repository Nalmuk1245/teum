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
  // publicnode: llamarpc 403s datacenter IPs and is generally flakier
  ethereum: { key: "ethereum", family: "evm", label: "Ethereum", native: "ETH", evmChainId: 1, rpc: env("WALLET_RPC_ETHEREUM", "https://ethereum-rpc.publicnode.com"), explorer: "https://etherscan.io/tx/" },
  polygon: { key: "polygon", family: "evm", label: "Polygon", native: "POL", evmChainId: 137, rpc: env("WALLET_RPC_POLYGON", "https://polygon-rpc.com"), explorer: "https://polygonscan.com/tx/" },
  arbitrum: { key: "arbitrum", family: "evm", label: "Arbitrum One", native: "ETH", evmChainId: 42161, rpc: env("WALLET_RPC_ARBITRUM", "https://arb1.arbitrum.io/rpc"), explorer: "https://arbiscan.io/tx/" },
  optimism: { key: "optimism", family: "evm", label: "Optimism", native: "ETH", evmChainId: 10, rpc: env("WALLET_RPC_OPTIMISM", "https://mainnet.optimism.io"), explorer: "https://optimistic.etherscan.io/tx/" },
  base: { key: "base", family: "evm", label: "Base", native: "ETH", evmChainId: 8453, rpc: env("WALLET_RPC_BASE", "https://mainnet.base.org"), explorer: "https://basescan.org/tx/" },
  bsc: { key: "bsc", family: "evm", label: "BNB Chain", native: "BNB", evmChainId: 56, rpc: env("WALLET_RPC_BSC", "https://bsc-dataseed.binance.org"), explorer: "https://bscscan.com/tx/" },
  avalanche: { key: "avalanche", family: "evm", label: "Avalanche C", native: "AVAX", evmChainId: 43114, rpc: env("WALLET_RPC_AVAX", "https://api.avax.network/ext/bc/C/rpc"), explorer: "https://snowtrace.io/tx/" },
  // ── 확장 EVM 체인 (OKX 지갑 API 지원 확인됨; 전송은 동일 ethers 경로) ──
  kaia: { key: "kaia", family: "evm", label: "Kaia", native: "KAIA", evmChainId: 8217, rpc: env("WALLET_RPC_KAIA", "https://public-en.node.kaia.io"), explorer: "https://kaiascan.io/tx/" },
  linea: { key: "linea", family: "evm", label: "Linea", native: "ETH", evmChainId: 59144, rpc: env("WALLET_RPC_LINEA", "https://rpc.linea.build"), explorer: "https://lineascan.build/tx/" },
  scroll: { key: "scroll", family: "evm", label: "Scroll", native: "ETH", evmChainId: 534352, rpc: env("WALLET_RPC_SCROLL", "https://rpc.scroll.io"), explorer: "https://scrollscan.com/tx/" },
  zksync: { key: "zksync", family: "evm", label: "zkSync Era", native: "ETH", evmChainId: 324, rpc: env("WALLET_RPC_ZKSYNC", "https://mainnet.era.zksync.io"), explorer: "https://era.zksync.network/tx/" },
  mantle: { key: "mantle", family: "evm", label: "Mantle", native: "MNT", evmChainId: 5000, rpc: env("WALLET_RPC_MANTLE", "https://rpc.mantle.xyz"), explorer: "https://mantlescan.xyz/tx/" },
  blast: { key: "blast", family: "evm", label: "Blast", native: "ETH", evmChainId: 81457, rpc: env("WALLET_RPC_BLAST", "https://rpc.blast.io"), explorer: "https://blastscan.io/tx/" },
  sonic: { key: "sonic", family: "evm", label: "Sonic", native: "S", evmChainId: 146, rpc: env("WALLET_RPC_SONIC", "https://rpc.soniclabs.com"), explorer: "https://sonicscan.org/tx/" },
  xlayer: { key: "xlayer", family: "evm", label: "X Layer", native: "OKB", evmChainId: 196, rpc: env("WALLET_RPC_XLAYER", "https://rpc.xlayer.tech"), explorer: "https://www.oklink.com/x-layer/tx/" },
  cronos: { key: "cronos", family: "evm", label: "Cronos", native: "CRO", evmChainId: 25, rpc: env("WALLET_RPC_CRONOS", "https://evm.cronos.org"), explorer: "https://cronoscan.com/tx/" },
  fantom: { key: "fantom", family: "evm", label: "Fantom", native: "FTM", evmChainId: 250, rpc: env("WALLET_RPC_FANTOM", "https://rpcapi.fantom.network"), explorer: "https://ftmscan.com/tx/" },
  manta: { key: "manta", family: "evm", label: "Manta Pacific", native: "ETH", evmChainId: 169, rpc: env("WALLET_RPC_MANTA", "https://pacific-rpc.manta.network/http"), explorer: "https://pacific-explorer.manta.network/tx/" },
  metis: { key: "metis", family: "evm", label: "Metis", native: "METIS", evmChainId: 1088, rpc: env("WALLET_RPC_METIS", "https://andromeda.metis.io/?owner=1088"), explorer: "https://andromeda-explorer.metis.io/tx/" },
  gnosis: { key: "gnosis", family: "evm", label: "Gnosis", native: "XDAI", evmChainId: 100, rpc: env("WALLET_RPC_GNOSIS", "https://rpc.gnosischain.com"), explorer: "https://gnosisscan.io/tx/" },
  celo: { key: "celo", family: "evm", label: "Celo", native: "CELO", evmChainId: 42220, rpc: env("WALLET_RPC_CELO", "https://forno.celo.org"), explorer: "https://celoscan.io/tx/" },
  ronin: { key: "ronin", family: "evm", label: "Ronin", native: "RON", evmChainId: 2020, rpc: env("WALLET_RPC_RONIN", "https://api.roninchain.com/rpc"), explorer: "https://app.roninchain.com/tx/" },
  wemix: { key: "wemix", family: "evm", label: "Wemix", native: "WEMIX", evmChainId: 1111, rpc: env("WALLET_RPC_WEMIX", "https://api.wemix.com"), explorer: "https://wemixscan.com/tx/" },
  monad: { key: "monad", family: "evm", label: "Monad", native: "MON", evmChainId: 143, rpc: env("WALLET_RPC_MONAD", "https://rpc.monad.xyz"), explorer: "https://monadscan.com/tx/" },
  hyperevm: { key: "hyperevm", family: "evm", label: "HyperEVM", native: "HYPE", evmChainId: 999, rpc: env("WALLET_RPC_HYPEREVM", "https://rpc.hyperliquid.xyz/evm"), explorer: "https://hyperevmscan.io/tx/" },
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
  if (s.includes("kaia") || s.includes("klaytn") || s.includes("klay")) return "kaia";
  if (s.includes("linea")) return "linea";
  if (s.includes("scroll")) return "scroll";
  if (s.includes("zksync") || s.includes("era")) return "zksync";
  if (s.includes("mantle")) return "mantle";
  if (s.includes("blast")) return "blast";
  if (s.includes("sonic")) return "sonic";
  if (s.includes("x layer") || s.includes("xlayer")) return "xlayer";
  if (s.includes("cronos")) return "cronos";
  if (s.includes("fantom")) return "fantom";
  if (s.includes("manta")) return "manta";
  if (s.includes("metis")) return "metis";
  if (s.includes("gnosis") || s.includes("xdai")) return "gnosis";
  if (s.includes("celo")) return "celo";
  if (s.includes("ronin")) return "ronin";
  if (s.includes("wemix")) return "wemix";
  if (s.includes("monad")) return "monad";
  if (s.includes("hyperevm") || s.includes("hyperliquid")) return "hyperevm";
  if (s.includes("ethereum") || s.includes("erc20")) return "ethereum";
  return ""; // unknown
}

export const getChain = (key: string): ChainInfo | undefined => CHAINS[key];

// Venue direction helpers — routing rules depend on KR vs overseas.
export const isKr = (v?: string) => v === "upbit" || v === "bithumb";
export const isGlobal = (v?: string) => v === "binance" || v === "bybit" || v === "okx";

// Binance's network code per chain key (withdraw/deposit-address `network`
// param and networkList[].network matching).
export const BINANCE_NET: Record<string, string> = {
  ethereum: "ETH", polygon: "MATIC", arbitrum: "ARBITRUM", optimism: "OPTIMISM",
  base: "BASE", bsc: "BSC", avalanche: "AVAXC", xrp: "XRP", tron: "TRX", solana: "SOL",
  // 확장 체인 — 코드가 틀리면 매칭만 안 될 뿐 안전 (출금 라우팅 시 무시됨)
  kaia: "KAIA", fantom: "FTM", celo: "CELO", ronin: "RONIN", zksync: "ZKSYNCERA",
  scroll: "SCROLL", linea: "LINEA", mantle: "MANTLE", sonic: "SONIC", metis: "METIS",
};
