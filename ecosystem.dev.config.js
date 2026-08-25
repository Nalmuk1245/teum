// pm2 dev 설정 — UI를 만지는 동안 쓰는 모드.
//
//   pm2 delete teum && pm2 start ecosystem.dev.config.js && pm2 save
//
// 왜 따로 두나: 이 박스는 1코어·955MB라 `next build`가 8분 걸린다(스왑 스래싱).
// 화면을 고치는 동안 매번 그걸 기다릴 수는 없다. dev는 요청한 페이지만 즉석
// 컴파일하므로 저장 → 새로고침이면 끝이다.
//
// 대가(알고 쓸 것):
//   ① 메모리를 더 먹는다 — webpack·소스맵이 상주. coin-tracker가 무거우면
//      스왑이 돈다. 상시 운용은 프로덕션(ecosystem.config.js)으로 되돌릴 것.
//   ② 첫 요청이 느리다 (그 라우트를 그때 컴파일).
//   ③ **프로덕션에서만 나는 버그를 못 잡는다.** 실제로 겪었다: 프로덕션 CSS
//      압축기가 rgba()를 hsla()로 줄이는데 lightweight-charts가 hsla를 못 읽어
//      차트가 통째로 죽었고, dev에서는 CSS가 압축되지 않아 멀쩡히 보였다.
//      → 기능을 마무리할 땐 프로덕션으로 한 번 빌드해 확인하고 넘어갈 것.
//
// --turbo: Turbopack. 웹팩 dev는 이 박스(1코어)에서 라우트당 90~120초가 걸렸다.
// 바인딩은 프로덕션과 동일하게 루프백 전용(package.json의 dev 스크립트가 -H를
// 들고 있다). 외부에서 볼 땐 SSH 터널을 쓴다.
module.exports = {
  apps: [
    {
      name: "teum",
      script: "node_modules/next/dist/bin/next",
      args: "dev --turbo -p 3100 -H 127.0.0.1",
      cwd: __dirname,
      env: { NODE_ENV: "development" },
      autorestart: true,
      // dev는 상주 메모리가 커서 프로덕션(900M)보다 여유를 준다.
      max_memory_restart: "1200M",
      restart_delay: 3000,
      min_uptime: "30s",
      max_restarts: 10,
      time: true,
    },
  ],
};
