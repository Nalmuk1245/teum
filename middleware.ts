// 모든 /api 요청이 지나는 한 곳 — 출처 확인.
//
// 라우트마다 가드를 붙이면 새 라우트를 만들 때마다 빠뜨릴 수 있다. 미들웨어는
// 빠뜨릴 수가 없다는 게 요점이다. 판단 로직은 lib/originGuard.ts에 순수 함수로
// 두고(테스트 가능), 여기서는 헤더만 넘긴다.

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { checkRequestOrigin } from "@/lib/originGuard";

export function middleware(req: NextRequest) {
  const verdict = checkRequestOrigin({
    method: req.method,
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
  });
  if (!verdict.ok) {
    return NextResponse.json({ ok: false, message: verdict.reason }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
