// dev 모드를 공인 IP로 여는 변형 — 빌드 없이 코드 변경이 바로 반영된다 (작업 중 전용).
// 전제: .env.local에 BASIC_AUTH·ALLOWED_HOSTS (미들웨어가 잠근다).
// 주의: dev는 webpack/turbopack이 상주해 955MB 박스에서 스왑을 크게 먹는다 (2026-09-17 스래싱 원인).
// 작업이 끝나면 `pm2 delete teum && npm run build && pm2 start ecosystem.public.config.js`로 되돌린다.
// 메모리 상한을 700M으로 낮춰 박스 전체가 스와핑에 빠지기 전에 재시작되게 한다.
const base = require("./ecosystem.dev.config.js");
const app = { ...base.apps[0], args: "dev --turbo -p 3100 -H 0.0.0.0", max_memory_restart: "700M" };
module.exports = { apps: [app] };
