// 체인 코드 정규화 + 경로 선택 — 돈이 나가는 체인을 고르는 로직이라 못을 박는다.
//
// 세 가지 회귀를 막는다:
//  1) 거래소 표기가 달라도 같은 체인으로 맞춰야 한다 (바낸 AVAXC = OKX Avalanche C-Chain).
//  2) 우리 체인이 막혀도 양쪽이 같이 연 다른 체인이 있으면 그리로 간다.
//  3) 모르는 건 모른다고 한다 — 표기 미매핑은 null, 목록에 없으면 false. OR로 열지 않는다.

import { describe, it, expect } from "vitest";
import { canonChain, pickRoute, venueChainState, type NetRow } from "@/lib/netcodes";
import { chainKeyFromLabel } from "@/lib/chains";

const row = (net: string, chainKey: string, deposit = true, withdraw = true, extra: Partial<NetRow> = {}): NetRow =>
  ({ net, chainKey, deposit, withdraw, ...extra });
const eta = (label: string, confirms: number) => (label.toLowerCase().includes("tron") ? 3 : label.toLowerCase().includes("ethereum") ? 6 : 10) + confirms * 0;

describe("canonChain — 거래소 표기 → chainKey", () => {
  it("이더리움 계열 표기를 전부 ethereum으로", () => {
    for (const x of ["ETH", "ERC20", "erc-20", "Ethereum", "Ethereum (ERC20)"]) expect(canonChain(x)).toBe("ethereum");
  });
  it("트론·BSC·아발란체·아비트럼의 거래소별 별칭", () => {
    for (const x of ["TRX", "TRC20", "Tron"]) expect(canonChain(x)).toBe("tron");
    for (const x of ["BSC", "BEP20", "BNB Smart Chain"]) expect(canonChain(x)).toBe("bsc");
    for (const x of ["AVAXC", "AVAX-C", "Avalanche C-Chain"]) expect(canonChain(x)).toBe("avalanche");
    for (const x of ["ARBITRUM", "ARB", "Arbitrum One"]) expect(canonChain(x)).toBe("arbitrum");
  });
  it("코드가 코인 티커와 같으면 그 코인의 자기 체인 (레지스트리 밖 네이티브도 매칭 가능)", () => {
    expect(canonChain("BTC", "BTC")).toBe("native:BTC");
    expect(canonChain("ADA", "ADA")).toBe("native:ADA");
    // 레지스트리에 있는 체인은 티커와 같아도 정식 키로
    expect(canonChain("SOL", "SOL")).toBe("solana");
    expect(canonChain("TRX", "TRX")).toBe("tron");
  });
  it("모르는 표기는 빈 문자열, 폐지된 BEP2도 빈 문자열", () => {
    expect(canonChain("NOSUCHCHAIN")).toBe("");
    expect(canonChain("BEP2")).toBe("");
    expect(canonChain("")).toBe("");
    expect(canonChain(undefined)).toBe("");
  });
  it("Hedera가 zkSync로 잡히지 않는다 (\"era\" 부분일치 회귀)", () => {
    expect(chainKeyFromLabel("Hedera")).toBe("");
    expect(canonChain("Hedera")).toBe("");
    expect(chainKeyFromLabel("zkSync Era")).toBe("zksync");
  });
});

describe("venueChainState — 한 거래소의 (코인, 체인) 상태", () => {
  it("체인 데이터가 없는 거래소는 코인 단위로 강등", () => {
    expect(venueChainState(undefined, "ethereum", "deposit", { deposit: true, withdraw: false })).toBe(true);
    expect(venueChainState(undefined, "ethereum", "withdraw", { deposit: true, withdraw: false })).toBe(false);
    expect(venueChainState(undefined, "ethereum", "withdraw", null)).toBeNull();
  });
  it("행이 있으면 그 체인 값, 목록에 없으면 미지원(false)", () => {
    const rows = [row("ETH", "ethereum", true, false), row("BSC", "bsc")];
    expect(venueChainState(rows, "ethereum", "withdraw", null)).toBe(false);
    expect(venueChainState(rows, "bsc", "withdraw", null)).toBe(true);
    expect(venueChainState(rows, "tron", "withdraw", null)).toBe(false);
  });
  it("매핑 안 된 행이 남아 있으면 우리 체인일 수도 있으니 null (OR로 열지 않는다)", () => {
    const rows = [row("WEIRDCODE", ""), row("BSC", "bsc")];
    expect(venueChainState(rows, "tron", "withdraw", null)).toBeNull();
  });
});

describe("pickRoute — 양쪽 다 열린 체인 중 ETA 최단", () => {
  const fallback = { chainKey: "ethereum", label: "Ethereum (ERC20)", confirms: 12, feeCoin: 1 };

  it("기본 체인이 막혀도 다른 체인이 양쪽 다 열려 있으면 그리로 간다", () => {
    const r = pickRoute({
      base: "USDT", buyVenue: "binance", sellVenue: "upbit",
      nets: {
        binance: [row("ETH", "ethereum", true, false, { label: "Ethereum (ERC20)", confirms: 12 }), row("TRX", "tron", true, true, { label: "Tron (TRC20)", confirms: 20, feeCoin: 1 })],
        upbit: [row("ETH", "ethereum"), row("TRX", "tron")],
      },
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.chainKey).toBe("tron");
    expect(r.withdraw).toBe(true); expect(r.deposit).toBe(true);
    expect(r.alternatives).toBe(0);
  });

  it("여럿 열려 있으면 ETA 짧은 쪽, 대안 수를 센다", () => {
    const r = pickRoute({
      base: "USDT", buyVenue: "binance", sellVenue: "okx",
      nets: {
        binance: [row("ETH", "ethereum", true, true, { label: "Ethereum (ERC20)", confirms: 12 }), row("TRX", "tron", true, true, { label: "Tron (TRC20)", confirms: 20 })],
        okx: [row("ERC20", "ethereum"), row("TRC20", "tron")],
      },
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.chainKey).toBe("tron"); // eta 3 < 6
    expect(r.alternatives).toBe(1);
  });

  it("매도 거래소가 그 체인을 안 받으면 열린 매수 체인이라도 안 고른다", () => {
    const r = pickRoute({
      base: "USDT", buyVenue: "binance", sellVenue: "upbit",
      nets: {
        binance: [row("ETH", "ethereum", true, true, { label: "Ethereum (ERC20)", confirms: 12 }), row("TRX", "tron", true, true, { label: "Tron (TRC20)", confirms: 20 })],
        upbit: [row("ETH", "ethereum")], // 업비트는 ETH만
      },
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.chainKey).toBe("ethereum");
    expect(r.deposit).toBe(true);
  });

  it("체인 데이터가 없는 거래소(빗썸)는 코인 단위 상태로 판단한다", () => {
    const r = pickRoute({
      base: "XRP", buyVenue: "bithumb", sellVenue: "binance",
      nets: { binance: [row("XRP", "xrp", true, true, { label: "XRP Ledger", confirms: 1 })] },
      coinLevel: { buy: { deposit: true, withdraw: true }, sell: null },
      fallback: { chainKey: "xrp", label: "XRP Ledger", confirms: 1 }, eta,
    });
    expect(r.chainKey).toBe("xrp");
    expect(r.withdraw).toBe(true); expect(r.deposit).toBe(true);
  });

  it("아무 데도 안 열려 있으면 기본 체인을 돌려주되 상태는 막힘/미확인 그대로", () => {
    const r = pickRoute({
      base: "USDT", buyVenue: "binance", sellVenue: "upbit",
      nets: {
        binance: [row("ETH", "ethereum", true, false, { label: "Ethereum (ERC20)", confirms: 12 })],
        upbit: [row("ETH", "ethereum")],
      },
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.chainKey).toBe("ethereum");
    expect(r.withdraw).toBe(false);
    expect(r.reason).toMatch(/출금 막힘/);
  });

  it("키가 하나도 없으면 기본 체인 하나로만 판단하고 상태는 null", () => {
    const r = pickRoute({
      base: "LINK", buyVenue: "binance", sellVenue: "upbit", nets: {},
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.chainKey).toBe("ethereum");
    expect(r.withdraw).toBeNull(); expect(r.deposit).toBeNull();
    expect(r.confirms).toBe(12);
  });

  it("표기가 안 맞는 행만 있는 거래소는 그 체인을 열린 것으로 치지 않는다 (예전 OR 회귀)", () => {
    const r = pickRoute({
      base: "USDT", buyVenue: "binance", sellVenue: "upbit",
      nets: {
        binance: [row("ETH", "ethereum", true, true, { label: "Ethereum (ERC20)", confirms: 12 })],
        upbit: [row("MYSTERY", "", true, true)],
      },
      coinLevel: { buy: null, sell: null }, fallback, eta,
    });
    expect(r.deposit).toBeNull(); // 열림(true)이 아니다
    expect(r.withdraw).toBe(true);
  });
});

describe("pickRoute — 레지스트리 밖 네이티브 체인", () => {
  it("Stellar처럼 키가 없는 기본 체인은 native 키로 유지되고 ethereum으로 강등되지 않는다", () => {
    const r = pickRoute({
      base: "XLM", buyVenue: "okx", sellVenue: "upbit", nets: {},
      coinLevel: { buy: null, sell: null },
      fallback: { chainKey: "native:XLM", label: "Stellar", confirms: 1 },
      eta: (label) => (label === "Stellar" ? 1 : 99),
    });
    expect(r.chainKey).toBe("native:XLM");
    expect(r.label).toBe("Stellar");
    expect(r.etaMin).toBe(1);
  });
  it("거래소 행의 티커 코드(XLM)와 native 키가 맞물린다", () => {
    const r = pickRoute({
      base: "XLM", buyVenue: "binance", sellVenue: "upbit",
      nets: { binance: [{ net: "XLM", chainKey: canonChain("XLM", "XLM"), deposit: true, withdraw: true, label: "Stellar", confirms: 1 }], upbit: [{ net: "XLM", chainKey: canonChain("XLM", "XLM"), deposit: true, withdraw: true }] },
      coinLevel: { buy: null, sell: null },
      fallback: { chainKey: "native:XLM", label: "Stellar", confirms: 1 },
      eta: () => 1,
    });
    expect(r.withdraw).toBe(true); expect(r.deposit).toBe(true);
    expect(r.chainKey).toBe("native:XLM");
  });
});
