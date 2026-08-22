// 감시 소스 판정 — 서버(24h 스트립 집계)와 클라(카드의 상태 점)가 **같은 식**을
// 써야 한다. 예전엔 두 곳에 따로 적혀 있어서, 공지가 30분째 조용하면 점은
// 초록("30분 전")인데 바로 아래 스트립 칸은 빨강으로 나오는 자기모순이 있었다.
//
// 순수 함수 — 시간·상태를 인자로만 받는다 (서버는 스캔 틱에서, 클라는 폴링
// 응답으로 호출).

/** ok = 정상, warn = 고장(조치 필요), off = 미설정·대기(판정 보류) */
export type SrcState = "ok" | "warn" | "off";

/** 신선도 상한(초) — 이 시간 안에 수신이 있어야 "정상"이다. */
export const FRESH_SEC = {
  /** 공지 폴은 2.5초 주기 + 백오프 — 2분이면 확실히 죽은 것. */
  ann: 120,
  /** 마켓 diff는 3초 주기. */
  mkt: 60,
  /** 텔레그램은 채널이 조용할 수 있어 넉넉히. */
  tg: 600,
  /** 스캔 스냅샷. */
  scan: 60,
} as const;

/** 루프 멈춤 판정: worstMs는 10분 창의 최악값이라, 그대로 쓰면 1회 멈춤이
 *  이후 10분을 전부 down으로 칠한다. 발생 후 이 시간 안쪽만 down으로 본다. */
export const LAG_RECENT_SEC = 60;
export const LAG_BAD_MS = 400;

export type WatchInput = {
  annBlocked?: boolean;
  annOkAgoSec?: number | null;
  mktOkAgoSec?: number | null;
  tgConfigured?: boolean;
  tgOkAgoSec?: number | null;
  scanAgeSec?: number | null;
  lag?: { worstMs: number; worstAgoSec: number | null } | null;
};

const fresh = (ago: number | null | undefined, limit: number): boolean =>
  ago != null && ago < limit;

/** 소스별 상태. null 반환 = 판정 보류(미설정·데이터 없음) → 집계 표본에서 제외. */
export function srcVerdict(src: "ann" | "mkt" | "tg" | "scan" | "proc", w: WatchInput): SrcState | null {
  switch (src) {
    case "ann":
      if (w.annBlocked) return "warn";
      if (w.annOkAgoSec == null) return "off";
      return fresh(w.annOkAgoSec, FRESH_SEC.ann) ? "ok" : "warn";
    case "mkt":
      if (w.mktOkAgoSec == null) return "off";
      return fresh(w.mktOkAgoSec, FRESH_SEC.mkt) ? "ok" : "warn";
    case "tg":
      if (!w.tgConfigured) return null; // 미설정 — 고장이 아니다
      if (w.tgOkAgoSec == null) return "off";
      return fresh(w.tgOkAgoSec, FRESH_SEC.tg) ? "ok" : "warn";
    case "scan":
      if (w.scanAgeSec == null) return "off"; // 첫 스캔 대기
      return fresh(w.scanAgeSec, FRESH_SEC.scan) ? "ok" : "warn";
    case "proc": {
      if (!w.lag) return null;
      const stalled = w.lag.worstMs >= LAG_BAD_MS
        && w.lag.worstAgoSec != null && w.lag.worstAgoSec < LAG_RECENT_SEC;
      return stalled ? "warn" : "ok";
    }
  }
}

/** 24h 스트립 집계용 — ok/warn만 표본으로 센다(off·null은 제외). */
export function verdictSample(src: "ann" | "mkt" | "tg" | "scan" | "proc", w: WatchInput): boolean | null {
  const v = srcVerdict(src, w);
  return v === "ok" ? true : v === "warn" ? false : null;
}
