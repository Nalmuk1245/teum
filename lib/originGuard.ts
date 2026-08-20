// 로컬 콘솔의 실제 경계 — 요청이 **이 앱의 화면**에서 왔는가.
//
// 왜 필요한가: 이 앱은 로그인이 없고 루프백에만 바인딩된다. 그래서 "로컬 전용"
// 이면 안전하다고 착각하기 쉬운데, 루프백이 못 막는 호출자가 하나 있다 —
// **당신의 브라우저**다. 웹서핑 중 아무 페이지나 이런 걸 할 수 있다:
//
//     fetch("http://localhost:3100/api/risk", {
//       method: "POST",
//       headers: { "Content-Type": "text/plain" },  // preflight 없는 simple request
//       body: '{"maxPerTradeUsd":999999}',
//     })
//
// 응답은 CORS 때문에 못 읽지만 **부수효과는 그대로 일어난다**. 브라우저는 이미
// localhost 안에 있으므로 바인딩과 무관하다. (실측: 이 가드를 넣기 전에는
// 외부 Origin + text/plain 요청이 200으로 1회 한도를 999,999로 바꿨다.)
//
// 방어: 상태를 바꾸는 요청에 한해 Origin이 이 서버 자신인지 본다.
//   - Origin이 **있고 다르면** → 거부. 브라우저는 교차 출처 요청에서 Origin을
//     반드시 붙이고, 스크립트가 이 헤더를 위조·삭제할 수 없다(forbidden header).
//     그래서 이 한 줄이 브라우저발 CSRF를 통째로 막는다.
//   - Origin이 **없으면** → 통과. curl·크론 헬스체크·pm2 같은 비브라우저
//     클라이언트다. 이들을 막으면 운영 스크립트가 깨지는데, 정작 막으려던
//     브라우저는 Origin 생략이 불가능하므로 막아서 얻는 것도 없다.
//
// Host도 함께 본다 — DNS 리바인딩 방어. 공격자 도메인이 127.0.0.1로 해석되게
// 만들면 Origin·Host가 **둘 다** 그 도메인이라 위 비교를 통과해 버린다. Host가
// 로컬/사설망 주소일 때만 받으면 그 경로가 닫힌다.
//
// 이건 인증이 아니라 출처 확인이다. EXEC_TOKEN(자금 이동 액션)과 층이 다르고,
// 로그인을 대신하지도 않는다 — `start:lan`으로 LAN에 열면 같은 망의 curl은
// 그대로 들어온다(Origin을 안 붙이면 되니까). LAN 노출은 여전히 옵트인이다.

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** 상태를 바꾸는 메서드만 검사한다 — 조회는 부수효과가 없다. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** host[:port]에서 host만, 소문자로. 대괄호 IPv6은 그대로 둔다. */
function hostOnly(hostPort: string): string {
  const h = hostPort.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1); // [::1]:3100 → [::1]
  const i = h.lastIndexOf(":");
  return i > 0 ? h.slice(0, i) : h;
}

/** 로컬 또는 사설망 주소인가 (공인 도메인·공인 IP면 false). */
export function isLocalOrPrivateHost(hostPort: string): boolean {
  const h = hostOnly(hostPort);
  if (h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1") return true;
  if (h.endsWith(".localhost")) return true;
  // IPv4 사설 대역 — start:lan으로 LAN에 열었을 때의 접속 주소.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 127) return true;
  return false;
}

/** 이 요청을 받아도 되는가. 순수 함수 — 미들웨어가 헤더만 넘겨준다. */
export function checkRequestOrigin(req: {
  method: string;
  origin: string | null;
  host: string | null;
}): GuardVerdict {
  if (!MUTATING.has(req.method.toUpperCase())) return { ok: true };

  const host = req.host;
  if (!host) return { ok: false, reason: "Host 헤더 없음" };
  if (!isLocalOrPrivateHost(host)) {
    return { ok: false, reason: `외부 호스트로 들어온 요청 (Host: ${host}) — DNS 리바인딩 차단` };
  }

  const origin = req.origin;
  if (!origin) return { ok: true }; // 비브라우저 클라이언트 (curl·크론·pm2)

  let originHostPort: string;
  try {
    originHostPort = new URL(origin).host.toLowerCase();
  } catch {
    return { ok: false, reason: `Origin 파싱 실패 (${origin})` };
  }
  if (originHostPort !== host.trim().toLowerCase()) {
    return { ok: false, reason: `다른 사이트에서 온 요청 (Origin: ${origin}) — 이 화면에서 보낸 요청만 받습니다` };
  }
  return { ok: true };
}
