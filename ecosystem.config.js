// pm2 config — RUNBOOK 5절("pm2 자동 재시작")을 파일로 고정한 것.
//
//   npm run build && pm2 start ecosystem.config.js && pm2 save && pm2 startup
//
// 프로덕션 빌드(`next start`)로 돌린다. dev 모드로 상시 운용하면 webpack·소스맵이
// 상주해 메모리를 계속 먹고, 파일이 조금만 바뀌어도 (실행 중에도) 재컴파일한다.
module.exports = {
  apps: [
    {
      name: "arb",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3100",
      cwd: __dirname,
      env: { NODE_ENV: "production" },
      // 크래시 시 자동 재시작. uncaughtException 핸들러가 알림 후 exit(1) 하므로
      // "복구 불가 상태로 계속 주문을 받는" 대신 깨끗한 프로세스로 되살아난다.
      autorestart: true,
      // 메모리 누수 백스톱. 정상 상태는 수백 MB 수준이다.
      max_memory_restart: "900M",
      // 재시작 폭주 방지 — 부팅 직후 연속 실패면 간격을 벌린다.
      restart_delay: 3000,
      min_uptime: "30s",
      max_restarts: 10,
      // 로그는 pm2-logrotate가 돌린다 (pm2 install pm2-logrotate).
      time: true,
    },
  ],
};
