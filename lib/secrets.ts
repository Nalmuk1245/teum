// 설정창에서 넣는 키·설정의 서버 저장소.
//
// 동작: data/secrets.json(0600, gitignore 대상)에 저장하고, 저장/부팅 시
// process.env에 주입한다 — 기존 코드는 전부 process.env.X를 읽으므로
// 리팩토링 없이 즉시 반영된다. .env.local 값은 "파일에 없는 키"의 기본값
// (파일 값이 우선). 클라이언트에는 절대 원문을 돌려주지 않는다(끝 4자리만).

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "fs";
import path from "path";

const FILE = path.join(process.cwd(), "data", "secrets.json");

export type SecretDef = {
  name: string; // env 이름
  label: string;
  group: string;
  secret?: boolean; // true = 마스킹 입력, 힌트만 반환
  placeholder?: string;
  danger?: boolean; // 자금 이동 가능 키 — UI에서 경고
};

export const SECRET_DEFS: SecretDef[] = [
  // 거래소 (읽기+거래+출금)
  { name: "BINANCE_KEY", label: "Binance API Key", group: "거래소" },
  { name: "BINANCE_SECRET", label: "Binance Secret", group: "거래소", secret: true },
  { name: "UPBIT_KEY", label: "Upbit Access Key", group: "거래소" },
  { name: "UPBIT_SECRET", label: "Upbit Secret", group: "거래소", secret: true },
  { name: "BITHUMB_KEY", label: "Bithumb API Key", group: "거래소" },
  { name: "BITHUMB_SECRET", label: "Bithumb Secret", group: "거래소", secret: true },
  { name: "BYBIT_KEY", label: "Bybit API Key", group: "거래소" },
  { name: "BYBIT_SECRET", label: "Bybit Secret", group: "거래소", secret: true },
  { name: "OKX_KEY", label: "OKX API Key", group: "거래소" },
  { name: "OKX_SECRET", label: "OKX Secret", group: "거래소", secret: true },
  { name: "OKX_PASSPHRASE", label: "OKX Passphrase", group: "거래소", secret: true },
  // DEX (OKX Web3 — 거래 키와 별개)
  { name: "OKX_WEB3_KEY", label: "OKX Web3 API Key", group: "DEX (OKX Web3)" },
  { name: "OKX_WEB3_SECRET", label: "OKX Web3 Secret", group: "DEX (OKX Web3)", secret: true },
  { name: "OKX_WEB3_PASSPHRASE", label: "OKX Web3 Passphrase", group: "DEX (OKX Web3)", secret: true },
  // 개인지갑
  { name: "WALLET_PRIVATE_KEY", label: "EVM 지갑 프라이빗 키", group: "개인지갑", secret: true, danger: true, placeholder: "0x… (자금 이동 가능 — 전용 지갑만)" },
  { name: "WALLET_ADDR_EVM", label: "EVM 지갑 주소 (키 없이 조회용)", group: "개인지갑", placeholder: "0x…" },
  { name: "WALLET_SOL_KEY", label: "솔라나 지갑 키 (base58)", group: "개인지갑", secret: true, danger: true },
  { name: "WALLET_ADDR_SOL", label: "솔라나 지갑 주소 (조회용)", group: "개인지갑" },
  { name: "WALLET_ADDR_TRON", label: "트론 지갑 주소 (조회용)", group: "개인지갑" },
  { name: "WALLET_ADDR_XRP", label: "XRP 지갑 주소 (조회용)", group: "개인지갑" },
  // 알림
  { name: "TELEGRAM_BOT_TOKEN", label: "텔레그램 봇 토큰", group: "알림", secret: true },
  { name: "TELEGRAM_CHAT_ID", label: "텔레그램 Chat ID", group: "알림" },
  // 상장따리
  { name: "LISTING_TG_CHANNEL", label: "상장 알림 TG 채널 (콤마 구분)", group: "상장따리", placeholder: "channel1,channel2" },
  { name: "LISTING_BUY_USD", label: "원클릭 매수 기본 금액 ($)", group: "상장따리", placeholder: "500" },
  { name: "LISTING_AUTO_MIN_MCAP", label: "자동매수 시총 하한 ($)", group: "상장따리", placeholder: "10000000" },
  { name: "LISTING_AUTO_MAX_PUMP", label: "자동매수 기펌핑 상한 (%)", group: "상장따리", placeholder: "50" },
  // 보안
  { name: "EXEC_TOKEN", label: "EXEC_TOKEN (라이브 실행 인증)", group: "보안", secret: true },
];

type Store = Record<string, string>;
const g = globalThis as unknown as { __arbSecretsLoaded?: boolean };

function readFile(): Store {
  try {
    if (existsSync(FILE)) return JSON.parse(readFileSync(FILE, "utf8")) as Store;
  } catch { /* malformed → ignore */ }
  return {};
}

/** 부팅/요청 시 1회 — 파일 값을 process.env에 주입 (파일이 env보다 우선). */
export function loadSecretsIntoEnv(): void {
  if (g.__arbSecretsLoaded) return;
  g.__arbSecretsLoaded = true;
  const store = readFile();
  for (const [k, v] of Object.entries(store)) {
    if (typeof v === "string" && v.length > 0) process.env[k] = v;
  }
}

/** 저장 — 빈 문자열은 "삭제"(파일에서 제거, env는 .env.local 값으로 복귀 불가하니 그냥 제거). */
export function saveSecrets(patch: Record<string, string>): { saved: string[]; cleared: string[] } {
  const allowed = new Set(SECRET_DEFS.map((d) => d.name));
  const store = readFile();
  const saved: string[] = [], cleared: string[] = [];
  for (const [k, vRaw] of Object.entries(patch)) {
    if (!allowed.has(k)) continue;
    const v = vRaw.trim();
    if (v === "") {
      if (k in store) { delete store[k]; delete process.env[k]; cleared.push(k); }
      continue;
    }
    store[k] = v;
    process.env[k] = v;
    saved.push(k);
  }
  mkdirSync(path.dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2), "utf8");
  try { chmodSync(FILE, 0o600); } catch { /* windows */ }
  return { saved, cleared };
}

/** 클라이언트용 상태 — 원문 대신 설정 여부 + 끝 4자리 힌트만. */
export function secretsStatus(): { name: string; label: string; group: string; secret: boolean; danger: boolean; placeholder?: string; set: boolean; hint: string | null }[] {
  loadSecretsIntoEnv();
  return SECRET_DEFS.map((d) => {
    const v = process.env[d.name];
    const set = typeof v === "string" && v.length > 0;
    return {
      name: d.name, label: d.label, group: d.group,
      secret: !!d.secret, danger: !!d.danger, placeholder: d.placeholder,
      set,
      hint: set ? (d.secret ? `…${v!.slice(-4)}` : v!.length > 28 ? `${v!.slice(0, 12)}…${v!.slice(-6)}` : v!) : null,
    };
  });
}
