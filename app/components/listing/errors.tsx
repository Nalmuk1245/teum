"use client";

// ── 에러 문구 — 원문 대신 "무엇을 해야 하는지"를 말한다 ──────────────────────
// 라우트·라이브러리가 내는 실제 문자열에 맞춰 분류한다. 분류에 걸리면 사람 말로
// 바꾸고 원문은 괄호로 남긴다(디버깅을 위해). 안 걸리면 원문 그대로.
type ErrKind = { title: string; hint?: string; tone: "warn" | "bad" | "info" };
export function explainError(raw: string): ErrKind {
  const e = raw ?? "";
  const m = (re: RegExp) => re.test(e);
  // 우리가 일부러 막은 것 — 고장이 아니다
  if (m(/킬 스위치/)) return { title: "킬 스위치가 켜져 있습니다", hint: "운영 탭에서 해제 후 다시 시도", tone: "info" };
  if (m(/리스크 한도/)) return { title: "리스크 한도에 걸렸습니다", hint: e.replace(/^.*리스크 한도\s*—\s*/, ""), tone: "info" };
  if (m(/인증 실패|EXEC_TOKEN/)) return { title: "실행 토큰 인증 실패", hint: "설정 ⚙에서 EXEC_TOKEN 등록(라이브 실행에 필요)", tone: "warn" };
  // 설정이 빠진 것 — 넣으면 해결
  if (m(/OKX_WEB3 키|OKX Web3 키/)) return { title: "OKX Web3 키가 없습니다", hint: "설정 ⚙ → OKX Web3 등록", tone: "warn" };
  if (m(/SOL 지갑 키|WALLET_SOL_KEY/)) return { title: "솔라나 지갑 키가 없습니다", hint: "WALLET_SOL_KEY·WALLET_ADDR_SOL 설정", tone: "warn" };
  if (m(/개인지갑 키 없음|지갑 키/)) return { title: "개인지갑 키가 없습니다", hint: "설정 ⚙ → 개인지갑 (라이브 전송에 필요)", tone: "warn" };
  if (m(/키 없음|key|unauthor|401|403/i)) return { title: "API 키가 없거나 권한이 부족합니다", hint: "설정 ⚙에서 해당 거래소 키 확인", tone: "warn" };
  // 시장 쪽 사정 — 다른 경로를 쓰라는 뜻
  if (m(/미지원 체인/)) return { title: "이 체인은 아직 지원하지 않습니다", hint: "다른 체인이나 CEX로", tone: "info" };
  if (m(/컨트랙트 해석 실패|컨트랙트 미확인/)) return { title: "토큰 컨트랙트를 확정하지 못했습니다", hint: "심볼이 겹치는 토큰일 수 있음 — 수동 확인 전엔 매수 금지", tone: "bad" };
  if (m(/해외 미상장/)) return { title: "해외 거래소에 아직 없습니다", hint: "DEX로만 살 수 있습니다", tone: "info" };
  if (m(/route|라우트|liquidity|유동성|no pool/i)) return { title: "이 체인엔 살 수 있는 풀이 없습니다", hint: "다른 체인이나 CEX로 사세요", tone: "bad" };
  if (m(/슬리피지/)) return { title: "슬리피지가 상한을 넘었습니다", hint: "규모를 줄이거나 호가가 회복될 때까지 대기", tone: "warn" };
  if (m(/잔고|insufficient|balance/i)) return { title: "잔고가 부족합니다", hint: "해당 거래소·지갑 잔고 확인", tone: "warn" };
  if (m(/가스|gas/i)) return { title: "가스가 부족합니다", hint: "지갑에 해당 체인 네이티브 코인 충전", tone: "warn" };
  if (m(/허니팟|honeypot|전송세|transfer tax/i)) return { title: "매도 제한 토큰으로 의심됩니다", hint: "허니팟·전송세 — 사지 마세요", tone: "bad" };
  // 일시적
  if (m(/timeout|시간 초과|응답 없음|network|fetch failed/i)) return { title: "서버 응답이 없습니다", hint: "일시적일 수 있음 — 잠시 후 자동 재시도", tone: "warn" };
  if (m(/rate|too many|429/i)) return { title: "요청이 너무 잦습니다 (레이트리밋)", hint: "잠시 후 다시", tone: "warn" };
  if (m(/규모가 0|base 필요|필요$/)) return { title: "입력값이 비었습니다", hint: e, tone: "info" };
  return { title: e || "알 수 없는 오류", tone: "warn" };
}
export function ErrBox({ raw, compact }: { raw: string; compact?: boolean }) {
  const k = explainError(raw);
  const color = k.tone === "bad" ? "var(--neg)" : k.tone === "info" ? "var(--text-dim)" : "var(--amber)";
  return (
    <div style={{ fontSize: 11, color, padding: compact ? "4px 8px" : "6px 10px", background: "var(--card)", borderRadius: 9, border: `1px solid ${k.tone === "bad" ? "var(--neg-soft)" : "var(--border)"}` }}>
      <b>{k.title}</b>
      {k.hint && <span style={{ color: "var(--text-dim)", marginLeft: 6 }}>· {k.hint}</span>}
      {k.title !== raw && <span style={{ color: "var(--text-mute)", marginLeft: 6, fontSize: 10 }}>({raw.slice(0, 60)})</span>}
    </div>
  );
}
