import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { MaintenanceBanner } from "@/components/MaintenanceBanner";
import { OfflineBanner } from "@/components/OfflineBanner";
import { Providers } from "@/components/Providers";
import { isDemoModeEnabled } from "@/lib/demo-mode";
import { getMaintenanceMessage, isMaintenanceMode } from "@/lib/maintenance";

import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  title: {
    default: "TrustBridge Dashboard",
    template: "%s | TrustBridge",
  },
  description:
    "Register your Stellar address for TrustBridge Wave payouts. Maintainers track contributor readiness across GitHub and Stellar.",
  keywords: [
    "TrustBridge",
    "Stellar",
    "USDC",
    "open source",
    "contributor payouts",
    "GitHub",
  ],
  openGraph: {
    title: "TrustBridge Dashboard",
    description:
      "GitHub → Stellar address mapping with live trustline validation for Wave payouts.",
    type: "website",
  },
  // PWA manifest
  manifest: "/manifest.json",
  // Theme colour for mobile browser chrome (matches Stellar purple brand color)
  themeColor: "#3E1BDB",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const maintenance = await isMaintenanceMode();
  const demoMode = isDemoModeEnabled();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Service worker registration.
         *
         * Inline script rather than a separate file so Next.js does not need
         * next-pwa or any additional build tooling. The SW is a plain static
         * file served from /public/sw.js — no bundling required.
         *
         * Security notes:
         *   - The SW scope is "/" (same as start_url in manifest.json).
         *   - The SW never caches /api/* routes (see public/sw.js).
         *   - We only register when the browser supports serviceWorker to
         *     avoid console errors in Safari < 11.1 or non-HTTPS contexts
         *     (Next.js dev server uses HTTP, so the SW won't register locally
         *     unless --experimental-https is used — that is intentional).
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function(err) {
      // Registration can legitimately fail in non-HTTPS contexts (local dev).
      // Suppress console noise for expected failures.
      if (process && process.env && process.env.NODE_ENV === 'development') return;
      console.warn('[TrustBridge] Service worker registration failed:', err);
    });
  });
}
`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans min-h-screen`}>
        <a
          href="#main-content"
          className="sr-only z-[100] rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
        >
          Skip to main content
        </a>
        <Providers demoMode={demoMode}>
          <MaintenanceBanner
            enabled={maintenance}
            message={getMaintenanceMessage()}
          />
          {/* Offline connectivity banner — client component, renders only when navigator.onLine is false */}
          <OfflineBanner />
          {children}
        </Providers>
      </body>
    </html>
  );
}
