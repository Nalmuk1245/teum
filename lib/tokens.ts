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
  AAVE: { ethereum: { address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", decimals: 18 } },
  MKR: { ethereum: { address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2", decimals: 18 } },
  LDO: { ethereum: { address: "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", decimals: 18 } },
  CRV: { ethereum: { address: "0xD533a949740bb3306d119CC777fa900bA034cd52", decimals: 18 } },
  GRT: { ethereum: { address: "0xc944E90C64B2c07662A292be6244BDf05Cda44a7", decimals: 18 } },
  SAND: { ethereum: { address: "0x3845badAde8e6dFF049820680d1F14bD3903a5d0", decimals: 18 } },
  MANA: { ethereum: { address: "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942", decimals: 18 } },
  APE: { ethereum: { address: "0x4d224452801ACEd8B2F0aebE155379bb5D594381", decimals: 18 } },
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

// 온체인 decimals() 직접 확인 — OKX가 decimals를 안 줄 때의 정답지.
async function erc20Decimals(chainKey: string, address: string): Promise<number | null> {
  try {
    const { JsonRpcProvider, Contract } = await import("ethers");
    const provider = new JsonRpcProvider(CHAINS[chainKey].rpc, undefined, { staticNetwork: true });
    const c = new Contract(address, ["function decimals() view returns (uint8)"], provider);
    return Number(await c.decimals());
  } catch { return null; }
}

// 온체인 symbol() 직접 확인 — cex-dex 동적 후보가 "바낸의 그 코인"과 같은
// 토큰인지 검증하는 데 쓴다(CoinGecko 대체). 로컬/공개 RPC라 CG처럼 레이트리밋
// 예산을 갉아먹지 않는다. 실패(구형 bytes32 심볼 등) = null → 호출부에서 강등.
export async function erc20Symbol(chainKey: string, address: string): Promise<string | null> {
  try {
    const { JsonRpcProvider, Contract } = await import("ethers");
    const provider = new JsonRpcProvider(CHAINS[chainKey].rpc, undefined, { staticNetwork: true });
    const c = new Contract(address, ["function symbol() view returns (string)"], provider);
    const sym = String(await c.symbol()).trim();
    return sym.length ? sym : null;
  } catch { return null; }
}

// okxWallet 체인 표기 ↔ chains.ts 키
const OKX_CHAIN_SHORT: Record<string, string> = {
  ethereum: "eth", optimism: "op", bsc: "bsc", polygon: "poly",
  base: "base", arbitrum: "arb", avalanche: "avax",
  kaia: "kaia", linea: "linea", scroll: "scrl", zksync: "zks",
  mantle: "mnt", blast: "blast", sonic: "sonic", xlayer: "xlyr",
  cronos: "cro", fantom: "ftm", manta: "manta", metis: "metis",
  gnosis: "gno", celo: "celo", ronin: "ronin", wemix: "wemix", monad: "monad",
};

/** tokenFor의 비동기 확장 — 큐레이션 맵에 없으면 자동 해석 (EVM만).
 *
 *  우선순위: ① 큐레이션 맵 ② 경로 DB의 온체인 검증분 ③ OKX 토큰리스트
 *            ④ 내 지갑 실보유 토큰(OKX 잔고).
 *
 *  ②~④는 전부 온체인 symbol()이 base와 일치해야 통과한다. 이 함수의 반환값으로
 *  실제 자금이 나가기 때문에 — 심볼만 같은 클론 토큰을 집으면 그대로 소각이다.
 *  지갑 보유분을 마지막으로 내린 이유도 같다: 누구나 내 주소로 같은 심볼의
 *  가짜 토큰을 에어드랍할 수 있고, 예전 순서에선 그게 1순위로 이겼다.
 *  decimals는 리스트에서, 없으면 온체인 decimals()로 확정. */
export async function resolveWalletAsset(base: string, chainKey: string): Promise<WalletAsset> {
  const cur = tokenFor(base, chainKey);
  if (cur.known) return cur;
  if (CHAINS[chainKey]?.family !== "evm") return cur; // 자동 해석은 EVM만 (SPL/TRC20 전송 미배선)

  // 이 컨트랙트가 정말 base인가. 확인 못 하면 채택하지 않는다.
  const symbolMatches = async (address: string) => {
    const sym = await erc20Symbol(chainKey, address);
    return !!sym && sym.toUpperCase() === base.toUpperCase();
  };

  try {
    // ② 경로 DB — 이미 온체인 검증을 통과한 항목만 나온다 (네트워크 왕복 0).
    const { verifiedContract } = await import("./tokenRoutes");
    const known = verifiedContract(base, chainKey);
    if (known) return { kind: "token", known: true, address: known.address, decimals: known.decimals };

    const { allTokens } = await import("./dex");

    // ③ OKX 토큰리스트 — 심볼 유일할 때만 (중복 심볼 = 모호 → 차단 유지).
    const list = await allTokens(chainKey);
    const t = list.get(base);
    if (t && (await symbolMatches(t.address))) {
      return { kind: "token", known: true, address: t.address, decimals: t.decimals };
    }

    // ④ 지갑이 실제 들고 있는 토큰 — 리스트에 아직 없는 신규 상장이 여기서 잡힌다.
    const short = OKX_CHAIN_SHORT[chainKey];
    if (short) {
      const { okxAllWalletCoins } = await import("./okxWallet");
      const evmAddr = process.env.WALLET_ADDR_EVM ?? null;
      const coins = await okxAllWalletCoins({ evm: evmAddr }).catch(() => null);
      const held = coins?.find((c) => c.symbol === base && c.chain === short && c.contract);
      // 네이티브 표기는 contract가 비어 오므로 여기 오면 항상 토큰.
      if (held?.contract && (await symbolMatches(held.contract))) {
        const dec = list.get(base)?.address.toLowerCase() === held.contract.toLowerCase()
          ? list.get(base)!.decimals
          : await erc20Decimals(chainKey, held.contract);
        if (dec != null) return { kind: "token", known: true, address: held.contract, decimals: dec };
      }
    }
  } catch { /* 해석 실패 → unknown 유지 (송금 차단이 안전) */ }
  return { kind: "unknown", known: false };
}
