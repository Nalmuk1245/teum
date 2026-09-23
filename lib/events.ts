// 이벤트 로그 — 알림·게이트 전환·런 종료처럼 "그때 무슨 일이 있었나"를 파일로 남긴다.
//
// 텔레그램은 출구지 기록이 아니다. 미설정이면 notify()가 조용히 return해서 게이트
// 열림 알림 같은 사건이 어디에도 안 남았다. 여기(data/events.jsonl)는 텔레그램
// 여부와 무관하게 항상 쓴다. 한 줄 = 한 사건, append-only, 4MB 넘으면 날짜를
// 붙여 옆으로 치운다(지우지 않는다). 기록 실패가 본 작업을 깨면 안 되므로 전부 삼킨다.

import { promises as fs, existsSync, mkdirSync, statSync, renameSync } from "fs";
import path from "path";

const DIR = path.join(process.cwd(), "data");
const FILE = path.join(DIR, "events.jsonl");
const ROTATE_BYTES = 4 * 1024 * 1024;

export type EventType =
  | "gate.change"        // 게이트 상태 전환 (open/closed/suspect/unknown)
  | "alert.net"          // 임계 돌파 알림 (텔레그램 발송 시도와 무관하게 사건 자체)
  | "alert.gate_down"    // 갭이 있는데 입출금 정지
  | "alert.reopen"       // 닫혀 있던 입출금 열림
  | "telegram.sent" | "telegram.failed" | "telegram.unconfigured"
  | "run.error" | "run.cancelled"
  | "gate.watch"         // 고속 감시가 본 전환 (5초 단위)
  | "reopen.notice"      // 재개 공지 감지 (예정 시각)
  | "reopen.decision"    // 열림 확인 시 판단 (release/start/none + 사유)
  | "reopen.auto_start"  // 재개 자동 실행 시작/거부
  | "reopen.cfg"         // 설정 변경
  | "prepos.start" | "prepos.abort" // 사전 포지션 시작/철회
  | "listing.exit" | "listing.exit_cfg" // 상장따리 자동 청산
  | "listing.kr_run" | "listing.kr_sell"; // 상장따리 국내 매도 경로

export type EventRecord = { ts: number; type: EventType; base?: string; [k: string]: unknown };

export function logEvent(type: EventType, data: Omit<EventRecord, "ts" | "type"> = {}): void {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    try {
      if (existsSync(FILE) && statSync(FILE).size >= ROTATE_BYTES) {
        renameSync(FILE, `${FILE}.${new Date().toISOString().slice(0, 10)}`);
      }
    } catch { /* best-effort */ }
    void fs.appendFile(FILE, JSON.stringify({ ts: Date.now(), type, ...data }) + "\n", "utf8").catch(() => {});
  } catch { /* 기록이 본 작업을 깨면 안 된다 */ }
}

/** 최근 이벤트 (최신순). 운영 탭·사후 분석용. */
export async function readEvents(limit = 200, type?: EventType): Promise<EventRecord[]> {
  try {
    if (!existsSync(FILE)) return [];
    const raw = await fs.readFile(FILE, "utf8");
    const rows: EventRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      try { rows.push(JSON.parse(line) as EventRecord); } catch { /* 손상 줄 무시 */ }
    }
    const filtered = type ? rows.filter((r) => r.type === type) : rows;
    return filtered.slice(-limit).reverse();
  } catch { return []; }
}
