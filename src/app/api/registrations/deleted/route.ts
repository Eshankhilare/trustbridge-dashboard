import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import { listDeletedRegistrations } from "@/lib/maintainers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/**
 * GET /api/registrations/deleted — list soft-deleted registrations (maintainers only).
 *
 * Query params:
 * - limit: number of items per page (default: 25, max: 100)
 * - cursor: opaque cursor from a previous page's `nextCursor`
 *
 * Returns only registrations where `deletedAt` is not null.
 */
export async function GET(request: NextRequest) {
  const session = await requireMaintainerSession();
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const searchParams = request.nextUrl.searchParams;
  const limitParam = searchParams.get("limit");
  const cursor = searchParams.get("cursor") ?? undefined;

  let limit = DEFAULT_LIMIT;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0) {
      // Clamp to the maximum instead of falling back, so an explicit
      // over-max request still returns the largest allowed page.
      limit = Math.min(parsed, MAX_LIMIT);
    }
  }

  const maintainerOrgId = session.user.maintainerOrgId;
  const result = await listDeletedRegistrations({
    maintainerOrgId,
    limit,
    cursor,
  });

  return NextResponse.json(result);
}
