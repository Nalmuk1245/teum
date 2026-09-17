// 출처 확인 — 이 로컬 콘솔의 실제 경계.
//
// 회귀하면 조용히 뚫린다: 루프백 바인딩만 보고 "로컬이라 안전"이라고 넘기기
// 쉬운데, 브라우저는 이미 localhost 안에 있다. 실제로 가드 없을 때 외부 Origin +
// text/plain POST가 200으로 1회 한도를 999,999로 바꿨다.

import { describe, it, expect } from "vitest";
import { checkRequestOrigin, isLocalOrPrivateHost } from "@/lib/originGuard";

const req = (over: Partial<{ method: string; origin: string | null; host: string | null; allowedHosts: string[] }> = {}) => ({
  method: "POST", origin: null as string | null, host: "localhost:3100", ...over,
});

describe("조회는 통과", () => {
  it("GET/HEAD는 Origin과 무관하게 통과 — 부수효과가 없다", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkRequestOrigin(req({ method, origin: "https://evil.example.com" })).ok).toBe(true);
    }
  });
});

describe("브라우저발 CSRF 차단", () => {
  it("다른 사이트에서 온 POST는 거부", () => {
    const v = checkRequestOrigin(req({ origin: "https://evil.example.com" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/다른 사이트/);
  });

  it("같은 호스트라도 포트가 다르면 거부 — 다른 로컬 앱이 조종하지 못하게", () => {
    expect(checkRequestOrigin(req({ origin: "http://localhost:1234" })).ok).toBe(false);
  });

  it("DELETE/PUT/PATCH도 같은 검사를 받는다", () => {
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      expect(checkRequestOrigin(req({ method, origin: "https://evil.example.com" })).ok).toBe(false);
    }
  });

  it("망가진 Origin은 거부 (파싱 실패를 통과로 취급하지 않는다)", () => {
    expect(checkRequestOrigin(req({ origin: "not-a-url" })).ok).toBe(false);
  });
});

describe("정상 경로는 통과", () => {
  it("이 화면에서 보낸 요청 (Origin === Host)", () => {
    expect(checkRequestOrigin(req({ origin: "http://localhost:3100" })).ok).toBe(true);
  });

  it("127.0.0.1로 접속해도 통과", () => {
    expect(checkRequestOrigin(req({ origin: "http://127.0.0.1:3100", host: "127.0.0.1:3100" })).ok).toBe(true);
  });

  it("start:lan으로 열어 폰에서 접속해도 통과", () => {
    expect(checkRequestOrigin(req({ origin: "http://192.168.0.5:3100", host: "192.168.0.5:3100" })).ok).toBe(true);
  });

  it("Origin이 없으면 통과 — curl·크론 헬스체크·pm2. 브라우저는 교차 출처에서 Origin을 생략할 수 없으므로 이 예외로 CSRF가 새지 않는다", () => {
    expect(checkRequestOrigin(req({ origin: null })).ok).toBe(true);
  });
});

describe("DNS 리바인딩 차단", () => {
  it("Host가 공인 도메인이면 Origin이 일치해도 거부", () => {
    // 공격자 도메인이 127.0.0.1로 해석되면 Origin·Host가 둘 다 그 도메인이라
    // 단순 일치 비교는 통과해 버린다 — Host 자체를 봐야 막힌다.
    const v = checkRequestOrigin(req({ origin: "http://evil.example.com:3100", host: "evil.example.com:3100" }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/리바인딩/);
  });

  it("Host 헤더가 없으면 거부", () => {
    expect(checkRequestOrigin(req({ host: null })).ok).toBe(false);
  });
});

describe("ALLOWED_HOSTS — 공인 주소로 열 때", () => {
  const pub = "158.247.242.248:3101";

  it("허용 목록에 있는 공인 Host는 통과 (Origin 일치)", () => {
    expect(checkRequestOrigin(req({ origin: `http://${pub}`, host: pub, allowedHosts: [pub] })).ok).toBe(true);
  });

  it("포트를 뗀 host만 적어도 통과", () => {
    expect(checkRequestOrigin(req({ origin: `http://${pub}`, host: pub, allowedHosts: ["158.247.242.248"] })).ok).toBe(true);
  });

  it("목록에 없는 공인 Host는 여전히 거부 — 리바인딩 방어 유지", () => {
    const v = checkRequestOrigin(req({ origin: "http://evil.example.com:3101", host: "evil.example.com:3101", allowedHosts: [pub] }));
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toMatch(/리바인딩/);
  });

  it("허용 Host라도 Origin이 다른 사이트면 거부 — CSRF 방어는 그대로", () => {
    expect(checkRequestOrigin(req({ origin: "https://evil.example.com", host: pub, allowedHosts: [pub] })).ok).toBe(false);
  });

  it("빈 목록은 아무것도 열지 않는다", () => {
    expect(checkRequestOrigin(req({ origin: `http://${pub}`, host: pub, allowedHosts: [] })).ok).toBe(false);
  });
});

describe("isLocalOrPrivateHost", () => {
  it("로컬·사설망을 받는다", () => {
    for (const h of ["localhost", "localhost:3100", "127.0.0.1:3100", "[::1]:3100", "10.0.0.2:3100", "192.168.1.7:3100", "172.20.3.4:3100"]) {
      expect(isLocalOrPrivateHost(h)).toBe(true);
    }
  });

  it("공인 주소는 거부한다", () => {
    for (const h of ["evil.example.com", "8.8.8.8:3100", "172.32.0.1:3100", "1.2.3.4"]) {
      expect(isLocalOrPrivateHost(h)).toBe(false);
    }
  });
});
