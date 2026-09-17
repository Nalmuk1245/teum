// 공인 IP로 여는 변형 — ecosystem.config.js와 같되 바인딩만 0.0.0.0.
// 전제: .env.local에 BASIC_AUTH·ALLOWED_HOSTS가 설정돼 있을 것(미들웨어가 잠근다).
//   npm run build && pm2 start ecosystem.public.config.js && pm2 save
const base = require("./ecosystem.config.js");
const app = { ...base.apps[0], args: "start -p 3100 -H 0.0.0.0" };
module.exports = { apps: [app] };
