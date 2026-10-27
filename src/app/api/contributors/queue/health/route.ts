import { NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { backgroundQueue } from "@/lib/background-queue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await requireMaintainerSession())) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const health = await backgroundQueue.getWorkerHealthMetrics();
  return NextResponse.json({
    ...health,
    serverlessNotice:
      "Jobs are persisted in PostgreSQL. In serverless environments, in-memory worker polling is constrained to request lifecycles.",
  });
}
