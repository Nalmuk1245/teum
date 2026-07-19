/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
