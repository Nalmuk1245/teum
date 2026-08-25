/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 프로덕션 최적화
  poweredByHeader: false,            // X-Powered-By 헤더 제거
  compress: true,                    // gzip 응답
  productionBrowserSourceMaps: false, // 클라 소스맵 미생성 (빌드↓·용량↓)
  // 프로덕션 클라 번들에서 console.log 제거 (error/warn은 유지 — 크래시 진단용).
  // dev에서는 키 자체를 넣지 않는다: Turbopack이 compiler.removeConsole가 있으면
  // (값이 false여도) 지원 불가라며 기동을 거부한다. dev는 콘솔을 남겨야 맞기도 하다.
  ...(process.env.NODE_ENV === "production"
    ? { compiler: { removeConsole: { exclude: ["error", "warn"] } } }
    : {}),
};

export default nextConfig;
