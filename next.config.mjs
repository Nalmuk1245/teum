/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    // instrumentation.ts를 부팅 시 실행 — 스캔 루프·상장 감시·워치독이
    // "첫 HTTP 요청"이 아니라 프로세스 기동 시점에 무장된다. (무인 재시작 후
    // 브라우저를 아무도 열지 않으면 모트인 공지 감시가 꺼져 있던 문제)
    instrumentationHook: true,
  },
  // 프로덕션 최적화
  poweredByHeader: false,            // X-Powered-By 헤더 제거
  compress: true,                    // gzip 응답
  productionBrowserSourceMaps: false, // 클라 소스맵 미생성 (빌드↓·용량↓)
  compiler: {
    // 프로덕션 클라 번들에서 console.log 제거 (error/warn은 유지 — 크래시 진단용)
    removeConsole: process.env.NODE_ENV === "production" ? { exclude: ["error", "warn"] } : false,
  },
};

export default nextConfig;
