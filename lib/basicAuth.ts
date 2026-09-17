// Basic Auth — 이 앱을 루프백 밖으로 열 때의 최소 잠금.
//
// 이 앱엔 로그인이 없다. 출처 확인(originGuard)은 "다른 사이트의 브라우저"를
// 막는 것이지 "인터넷의 아무나"를 막는 게 아니다 — 포트가 공인망에 열리는 순간
// 누구든 런을 시작하고 한도를 바꿀 수 있다. RUNBOOK은 SSH 터널·리버스 프록시를
// 권하지만, 개인 도구가 그걸 매번 세우긴 무겁다. 그래서 프록시가 하던 Basic Auth를
// 미들웨어에 옵션으로 둔다: `BASIC_AUTH=user:pass`가 있으면 켜지고, 없으면 예전과
// 같다(루프백 전용 운용은 아무것도 바뀌지 않는다).
//
// 미들웨어(edge 런타임)에서 돌므로 node `crypto`를 쓰지 않는다 — atob·TextEncoder만.
// 비교는 길이·바이트를 전부 훑는 상수시간 비교: 앞 글자만 맞아도 빨리 실패하면
// 응답 시간으로 비밀번호를 한 글자씩 캘 수 있다.

/** `Authorization: Basic …` 헤더 → {user, pass}. 형식이 아니면 null. */
export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header) return null;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header.trim());
  if (!m) return null;
  let decoded: string;
  try { decoded = atob(m[1]); } catch { return null; }
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/** 상수시간 문자열 비교 — 길이가 달라도 끝까지 돈다. */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  const n = Math.max(ea.length, eb.length);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

/** 헤더가 `expected`("user:pass")와 일치하는가. expected가 비어 있으면 인증을
 *  요구하지 않는 것이므로 항상 true — 호출부가 먼저 "켜져 있나"를 보는 게 맞지만,
 *  실수로 빈 문자열이 들어와도 잠기지 않게. */
export function basicAuthOk(header: string | null, expected: string | undefined): boolean {
  if (!expected) return true;
  const got = parseBasicAuth(header);
  if (!got) return false;
  return timingSafeEqualStr(`${got.user}:${got.pass}`, expected);
}

/** `ALLOWED_HOSTS="1.2.3.4:3100,teum.example.com"` → 정규화된 목록. */
export function parseAllowedHosts(env: string | undefined): string[] {
  return (env ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}
