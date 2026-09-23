import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";
import localFont from "next/font/local";
import { MobileProvider } from "./mobile";

// Pretendard는 직접 서빙한다 (OFL). CDN 동적 서브셋은 글리프 묶음을 늦게 받아
// 숫자·라틴이 한동안 기본 글꼴로 그려졌다 — 탭마다 글자 모양이 달라 보인 원인.
const pretendard = localFont({
  src: "./fonts/PretendardVariable.woff2",
  weight: "45 920",
  display: "swap",
  variable: "--font-pretendard",
});

export const metadata: Metadata = {
  title: "TEUM · 틈",
  description: "Personal semi-automated arbitrage desk",
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
    <html lang="ko" className={pretendard.variable}>
      <body>
        <MobileProvider initial={isMobileUA}>{children}</MobileProvider>
      </body>
    </html>
  );
}
