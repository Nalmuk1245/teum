// 수동 컨트랙트 등록 — 운영자가 직접 입력한 토큰 주소.
//
// 자동 해석(경로 DB·리스트·보유분 교차 확인)이 커버 못 하는 마지막 구멍:
// CoinGecko에도 아직 없는 극신생 코인은 교차 확인이 불가능해 송금이 차단된다
// (fail-closed — 옳지만 막힌다). 이 모듈이 그 구멍을 **운영자의 명시적 결정**으로
// 메운다. 자동 소스보다 우선한다 — 사람이 직접 넣은 값이 최상위 권위다.
//
// 그래서 등록 절차가 곧 안전장치다:
//  - EVM만 받는다 (SPL/TRC20 전송 미배선 — 등록해 봐야 못 보낸다).
//  - 등록 시점에 온체인 symbol()·decimals()를 읽어 보여준다. 심볼이 다르면
//    force 없이 저장을 거부한다 — 오타 주소로 소각되는 것을 여기서 막는다.
//  - 네이티브 코인 심볼로는 등록 불가 (ETH를 토큰으로 보내는 사고 방지).
//  - 캐시가 아니라 운영자 데이터다: TTL 없음, eviction 없음, 삭제는 명시적으로만.

import { loadSection, saveSection } from "./persist";
import { CHAINS } from "./chains";
import { erc20Symbol } from "./tokens";

export type ManualToken = {
  address: string;
  decimals: number;
  /** 등록 시점에 온체인에서 읽은 심볼 (확인 실패면 null — force 등록). */
  symbol: string | null;
  /** 심볼이 base와 일치 확인됨. false = force로 넣은 항목 (UI에 경고 표시). */
  verified: boolean;
  addedAt: number;
};
type Store = Record<string, Record<string, ManualToken>>; // base → chain → entry

const g = globalThis as unknown as { __arbManualTokens?: Store };
function store(): Store {
  g.__arbManualTokens ??= loadSection<Store>("manualTokens") ?? {};
  return g.__arbManualTokens;
}
function save() { saveSection("manualTokens", store()); }

/** 운영자 등록 컨트랙트. resolveWalletAsset이 최우선으로 조회한다. */
export function manualToken(base: string, chain: string): ManualToken | null {
  return store()[base.toUpperCase()]?.[chain] ?? null;
}

export function listManualTokens(): { base: string; chain: string; entry: ManualToken }[] {
  const out: { base: string; chain: string; entry: ManualToken }[] = [];
  for (const [base, chains] of Object.entries(store()))
    for (const [chain, entry] of Object.entries(chains)) out.push({ base, chain, entry });
  return out.sort((a, b) => b.entry.addedAt - a.entry.addedAt);
}

export type AddResult =
  | { ok: true; symbol: string | null; decimals: number; verified: boolean }
  | { ok: false; message: string; foundSymbol?: string | null };

/**
 * 등록. 온체인 확인 결과가 base와 다르면 force 없이는 저장하지 않는다.
 * force여도 확인 결과는 저장해 UI가 "심볼 불일치" 경고를 계속 띄울 수 있게 한다.
 */
export async function addManualToken(
  baseRaw: string, chain: string, addressRaw: string, opts?: { force?: boolean },
): Promise<AddResult> {
  const base = baseRaw.trim().toUpperCase();
  const address = addressRaw.trim();
  const ch = CHAINS[chain];
  if (!base || !address) return { ok: false, message: "코인·주소 필요" };
  if (!ch) return { ok: false, message: `미지원 체인: ${chain}` };
  if (ch.family !== "evm") return { ok: false, message: "EVM 체인만 등록 가능 (SPL/TRC20 전송 미배선)" };
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return { ok: false, message: "EVM 주소 형식 아님 (0x + 40 hex)" };
  if (base === ch.native) return { ok: false, message: `${base}는 ${ch.label}의 네이티브 코인 — 토큰 등록 불가` };

  // 온체인 확인 — 이 주소가 실재하는 토큰이고, 심볼이 말하는 대로인가.
  const [symbol, decimals] = await Promise.all([
    erc20Symbol(chain, address),
    (async () => {
      try {
        const { JsonRpcProvider, Contract } = await import("ethers");
        const provider = new JsonRpcProvider(ch.rpc, undefined, { staticNetwork: true });
        const c = new Contract(address, ["function decimals() view returns (uint8)"], provider);
        return Number(await c.decimals());
      } catch { return null; }
    })(),
  ]);
  if (decimals == null) {
    // decimals조차 못 읽으면 토큰 컨트랙트가 아니거나 RPC가 죽었다 — force로도 불가.
    // decimals 없이 보내면 수량 자릿수가 틀려 10^n배 오전송이 된다.
    return { ok: false, message: "온체인 확인 실패 — 토큰 컨트랙트가 아니거나 RPC 오류 (decimals 필수라 force 불가)" };
  }
  const verified = !!symbol && symbol.toUpperCase() === base;
  if (!verified && !opts?.force) {
    return {
      ok: false, foundSymbol: symbol,
      message: symbol
        ? `온체인 심볼이 다름: ${symbol} ≠ ${base} — 주소를 다시 확인하거나, 맞다고 확신하면 강제 등록`
        : `온체인 심볼 확인 실패 — 맞다고 확신하면 강제 등록`,
    };
  }
  const s = store();
  (s[base] ??= {})[chain] = { address, decimals, symbol, verified, addedAt: Date.now() };
  save();
  return { ok: true, symbol, decimals, verified };
}

export function removeManualToken(base: string, chain: string): boolean {
  const s = store();
  const b = base.toUpperCase();
  if (!s[b]?.[chain]) return false;
  delete s[b][chain];
  if (!Object.keys(s[b]).length) delete s[b];
  save();
  return true;
}
