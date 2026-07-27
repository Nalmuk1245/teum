// ERC20 온체인 읽기 — symbol/decimals/balance 한 곳.
//
// 같은 3줄(JsonRpcProvider 생성 + Contract + 호출)이 5개 파일에 흩어져 있었다.
// 흩어진 복사본의 실제 비용은 중복이 아니라 **드리프트**다: 한 곳만
// staticNetwork를 빼먹거나 타임아웃 정책이 갈라져도 아무도 모른다.
// 여기 말고는 ethers로 ERC20을 직접 읽지 않는다.

import { CHAINS } from "./chains";

async function provider(chainKey: string) {
  const ch = CHAINS[chainKey];
  if (!ch) return null;
  const { JsonRpcProvider } = await import("ethers");
  // staticNetwork: 체인ID 자동감지 왕복 생략 — 공개 RPC에서 호출당 1 왕복 절약.
  return new JsonRpcProvider(ch.rpc, undefined, { staticNetwork: true });
}

async function call<T>(chainKey: string, address: string, abi: string, fn: (c: import("ethers").Contract) => Promise<T>): Promise<T | null> {
  try {
    const p = await provider(chainKey);
    if (!p) return null;
    const { Contract } = await import("ethers");
    return await fn(new Contract(address, [abi], p));
  } catch {
    return null; // 실패 = null — 호출부가 fail-closed 판단 (구형 bytes32 심볼 등 포함)
  }
}

export async function erc20Symbol(chainKey: string, address: string): Promise<string | null> {
  const s = await call(chainKey, address, "function symbol() view returns (string)", async (c) => String(await c.symbol()).trim());
  return s?.length ? s : null;
}

export async function erc20Decimals(chainKey: string, address: string): Promise<number | null> {
  return call(chainKey, address, "function decimals() view returns (uint8)", async (c) => Number(await c.decimals()));
}

/** raw 잔고 (BigInt). human 단위가 필요하면 erc20Balance를 쓴다. */
export async function erc20BalanceRaw(chainKey: string, address: string, owner: string): Promise<bigint | null> {
  return call(chainKey, address, "function balanceOf(address) view returns (uint256)", async (c) => BigInt(await c.balanceOf(owner)));
}

/** human 단위 잔고. decimals를 알면 넘겨서 온체인 왕복 하나를 아낀다. */
export async function erc20Balance(chainKey: string, address: string, owner: string, decimals?: number): Promise<number | null> {
  const raw = await erc20BalanceRaw(chainKey, address, owner);
  if (raw == null) return null;
  const dec = decimals ?? (await erc20Decimals(chainKey, address));
  if (dec == null) return null;
  const { formatUnits } = await import("ethers");
  return Number(formatUnits(raw, dec));
}

/** 네이티브 코인 잔고 (ETH/BNB 등, human 단위). */
export async function nativeBalance(chainKey: string, owner: string): Promise<number | null> {
  try {
    const p = await provider(chainKey);
    if (!p) return null;
    const { formatEther } = await import("ethers");
    return Number(formatEther(await p.getBalance(owner)));
  } catch {
    return null;
  }
}
