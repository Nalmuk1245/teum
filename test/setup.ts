// 테스트 격리 — 영속 계층은 `path.join(process.cwd(), "data")`에 쓴다.
//
// 이걸 안 갈아끼우면 테스트가 **운영 상태를 덮어쓴다**: risk 테스트의
// recordPnl(-1000)이 data/state/riskPnl.json에 그대로 flush돼서, 실제 일일 손실
// 한도 집계가 테스트 숫자로 오염된다(그리고 그 한도는 실거래를 막는 게이트다).
// 실제로 처음 돌렸을 때 오늘의 실현손익이 +$901로 바뀌어 있었다.
//
// 그래서 테스트 프로세스의 cwd를 임시 디렉터리로 옮긴다. 소스 임포트는
// vitest.config.ts의 `@` alias가 절대경로로 잡아주므로 영향받지 않는다.

import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const sandbox = mkdtempSync(path.join(tmpdir(), "arb-test-"));
process.chdir(sandbox);
