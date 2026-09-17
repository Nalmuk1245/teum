// 모든 요청이 지나는 한 곳 — (1) Basic Auth(옵션), (2) /api 출처 확인.
//
// 라우트마다 가드를 붙이면 새 라우트를 만들 때마다 빠뜨릴 수 있다. 미들웨어는
// 빠뜨릴 수가 없다는 게 요점이다. 판단 로직은 lib/originGuard.ts·lib/basicAuth.ts에
// 순수 함수로 두고(테스트 가능), 여기서는 헤더만 넘긴다.
//
// Basic Auth는 `BASIC_AUTH=user:pass`가 있을 때만 켜진다 — 루프백 전용 운용은
// 아무것도 바뀌지 않는다. 켜지면 화면·API 전부 잠기고, 브라우저는 첫 401 뒤
// 같은 출처 요청에 자격을 자동으로 붙이므로 UI는 그대로 동작한다.
// 예외는 `GET /api/health` 하나 — 헬스체크 크론(RUNBOOK "필수")이 자격 없이 치고,
// 이 응답엔 비밀이 없다(스캔 나이·기회 수·킬 여부·DRY 여부).

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRequestOrigin } from "@/lib/originGuard";
import { basicAuthOk, parseAllowedHosts } from "@/lib/basicAuth";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  const expected = process.env.BASIC_AUTH;
  const healthProbe = pathname === "/api/health" && req.method === "GET";
  if (expected && !healthProbe && !basicAuthOk(req.headers.get("authorization"), expected)) {
    return new NextResponse("인증 필요", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="teum", charset="UTF-8"' },
    });
  }

  if (pathname.startsWith("/api/")) {
    const verdict = checkRequestOrigin({
      method: req.method,
      origin: req.headers.get("origin"),
      host: req.headers.get("host"),
      allowedHosts: parseAllowedHosts(process.env.ALLOWED_HOSTS),
    });
    if (!verdict.ok) {
      return NextResponse.json({ ok: false, message: verdict.reason }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = {
  // 정적 청크·이미지·파비콘은 제외 — 인증을 걸 이유가 없고 매 요청 미들웨어를
  // 태우면 그만큼 느려진다. 나머지(화면·API) 전부.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
