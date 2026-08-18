import { defineConfig } from "vitest/config";
import path from "path";

// 테스트는 순수 로직 모듈만 본다 — 여기서 돌리는 것들은 네트워크·거래소 API를
// 건드리지 않는다(락·rate limiter·리스크 한도·플랜·비용 산식). 거래소 어댑터는
// 실키·실응답이 있어야 의미가 있으므로 RUNBOOK의 리허설이 계속 담당한다.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, ".") },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // setup이 cwd를 임시 디렉터리로 옮긴다 — 영속 계층이 운영 data/를 덮어쓰지
    // 않도록. setupFiles는 테스트 파일보다 먼저, 임포트 전에 돈다.
    setupFiles: ["test/setup.ts"],
  },
});
