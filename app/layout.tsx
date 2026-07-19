import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ARB · COCKPIT",
  description: "Personal semi-automated arbitrage cockpit",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <head>
        {/* 폰트 실제 출처(jsdelivr)에 preconnect — 이전엔 googleapis를 가리켜 효과 없었음 */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
          rel="stylesheet"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
