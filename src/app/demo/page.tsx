import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isDemoModeEnabled } from "@/lib/demo-mode";

import { DemoDashboard } from "./DemoDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Public demo",
  description:
    "Explore the TrustBridge maintainer dashboard with synthetic contributors, readiness statuses, exports, and activity data.",
};

/**
 * Public, read-only demo. Only available when NEXT_PUBLIC_DEMO_MODE=true.
 * The page never calls authenticated APIs or a database; all data is local.
 */
export default function DemoPage() {
  if (!isDemoModeEnabled()) {
    notFound();
  }

  return <DemoDashboard />;
}
