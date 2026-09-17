// Basic Auth — 앱을 공인망에 열 때의 유일한 잠금. 회귀하면 인터넷의 아무나
// 런을 시작할 수 있으므로 경계를 못으로 박는다.

import { describe, it, expect } from "vitest";
import { basicAuthOk, parseBasicAuth, timingSafeEqualStr, parseAllowedHosts } from "@/lib/basicAuth";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("parseBasicAuth", () => {
  it("정상 헤더를 user/pass로 나눈다 — 비밀번호에 ':'가 있어도 첫 ':'만 구분자", () => {
    expect(parseBasicAuth(`Basic ${b64("teum:p:a:ss")}`)).toEqual({ user: "teum", pass: "p:a:ss" });
  });
  it("Basic이 아니거나 base64가 아니거나 ':'가 없으면 null", () => {
    expect(parseBasicAuth(null)).toBeNull();
    expect(parseBasicAuth("Bearer abc")).toBeNull();
    expect(parseBasicAuth("Basic @@@")).toBeNull();
    expect(parseBasicAuth(`Basic ${b64("nocolon")}`)).toBeNull();
  });
});

describe("basicAuthOk", () => {
  const expected = "teum:s3cret";
  it("일치하면 통과", () => {
    expect(basicAuthOk(`Basic ${b64(expected)}`, expected)).toBe(true);
  });
  it("비밀번호·사용자 하나라도 다르면 거부", () => {
    expect(basicAuthOk(`Basic ${b64("teum:s3cre")}`, expected)).toBe(false);
    expect(basicAuthOk(`Basic ${b64("teum:s3cret2")}`, expected)).toBe(false);
    expect(basicAuthOk(`Basic ${b64("root:s3cret")}`, expected)).toBe(false);
  });
  it("헤더가 없으면 거부", () => {
    expect(basicAuthOk(null, expected)).toBe(false);
  });
  it("expected가 비어 있으면 인증 미사용 = 통과 (루프백 전용 운용은 바뀌지 않는다)", () => {
    expect(basicAuthOk(null, undefined)).toBe(true);
    expect(basicAuthOk(null, "")).toBe(true);
  });
});

describe("timingSafeEqualStr", () => {
  it("같으면 true, 길이가 달라도 예외 없이 false", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(timingSafeEqualStr("", "a")).toBe(false);
    expect(timingSafeEqualStr("한글:비번", "한글:비번")).toBe(true);
  });
});

describe("parseAllowedHosts", () => {
  it("콤마 구분·공백 제거·소문자·빈 항목 제거", () => {
    expect(parseAllowedHosts(" 1.2.3.4:3100, Teum.Example.com ,,")).toEqual(["1.2.3.4:3100", "teum.example.com"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
  });
});
