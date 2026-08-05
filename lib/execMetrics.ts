// 실행 품질 계측 — 주문마다 Order-to-Ack(전송→응답 ms)와 슬리피지(스냅샷가
// 대비 체결가)를 한 줄씩 영구 기록한다 (data/exec-metrics.jsonl, 로테이션).
//
// DRY에서도 기록한다 — 페이퍼 트레이딩의 목적이 "실전과 같은 모양의 데이터를
// 미리 쌓는 것"이라, 모의 지연·모의 VWAP 슬립도 같은 스키마로 남아야
// 실전 전환 후 dry vs live를 같은 화면에서 비교할 수 있다.

import { promises as fs, existsSync, mkdirSync, statSync, renameSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "exec-metrics.jsonl");
const ROTATE_BYTES = 4 * 1024 * 1024;

export type ExecMetric = {
  ts: number;
  op: "buy" | "sell" | "hedge" | "close" | "withdraw";
  venue: string;
  base: string;
  kind: string; // 전략 (kimchi 등)
  dry: boolean;
  ok: boolean;
  ackMs: number; // 주문 호출 → 결과 확보 (DRY는 모의 지연 포함)
  refPx?: number; // 스캔 스냅샷 가격 (그 다리의 표기 통화)
  fillPx?: number; // 평균 체결가 (같은 통화)
  slipPct?: number; // 불리한 방향이 + (buy: fill>ref, sell: fill<ref)
};

export function recordExec(m: Omit<ExecMetric, "ts">): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    try {
      if (existsSync(FILE) && statSync(FILE).size >= ROTATE_BYTES) {
        renameSync(FILE, `${FILE}.${new Date().toISOString().slice(0, 10)}`);
      }
    } catch { /* best-effort */ }
    void fs.appendFile(FILE, JSON.stringify({ ts: Date.now(), ...m }) + "\n", "utf8").catch(() => {});
  } catch { /* 계측 실패가 실행을 깨면 안 된다 */ }
}

/** 최근 기록 (신규순). 파일은 로테이션 상한이 있어 통읽기해도 작다. */
export async function readExecMetrics(limit = 2000): Promise<ExecMetric[]> {
  try {
    if (!existsSync(FILE)) return [];
    const raw = await fs.readFile(FILE, "utf8");
    const out: ExecMetric[] = [];
    for (const l of raw.split("\n")) {
      if (!l) continue;
      try { out.push(JSON.parse(l)); } catch { /* skip */ }
    }
    return out.reverse().slice(0, limit);
  } catch {
    return [];
  }
}
