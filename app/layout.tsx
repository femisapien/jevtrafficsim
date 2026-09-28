import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev Traffic Simulator",
  description:
    "One car crosses Chicago on Jev's signals. Fixed and Adaptive run the same trip.",
};

/**
 * `viewportFit: "cover"` is what makes `env(safe-area-inset-*)` real on a phone:
 * the bottom chrome then clears the home indicator and the Safari toolbar
 * instead of sitting under them.
 */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
