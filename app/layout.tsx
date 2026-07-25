import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import { MobileProvider } from "./mobile";

export const metadata: Metadata = {
  title: "ARB · COCKPIT",
  description: "Personal semi-automated arbitrage cockpit",
};

// First-paint layout hint. The client cannot fix this on its own: hydration must
// match the server HTML, so a client-only breakpoint always paints the desktop
// layout once before switching (a visibly broken frame on every phone load).
// matchMedia takes over as the authority right after mount — this only decides
// what gets rendered BEFORE that.
const MOBILE_UA = /Android|iPhone|iPod|iPad|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile|Mobile Safari/i;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const isMobileUA = MOBILE_UA.test(headers().get("user-agent") ?? "");
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
      <body>
        <MobileProvider initial={isMobileUA}>{children}</MobileProvider>
      </body>
    </html>
  );
}
