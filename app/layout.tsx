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
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
