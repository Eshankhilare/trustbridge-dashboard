import { NextRequest, NextResponse } from "next/server";

import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { requireOperator } from "@/lib/api-auth";
import {
  API_KEY_RATE_LIMIT,
  authenticateApiKey,
  buildRateLimitHeaders,
  hasScope,
  insufficientScopeResponse,
} from "@/lib/api-key-auth";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";
import { computeReadiness } from "@/lib/readiness";
import { recordAuditLog } from "@/lib/audit";
import { evaluateStaleExportGuard } from "@/lib/stale-export";
import { buildCsv, buildCsvFilename } from "@/lib/csv";
import type { ContributorRow } from "@/types";
import {
  parseExportPagination,
  streamJsonExport,
} from "@/lib/treasury-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface TreasuryExportItem {
  githubUsername: string;
  stellarAddress: string;
  readiness: "ready" | "low_reserve" | "not_ready";
  funded: boolean;
  trustlineReady: boolean;
  trustlineAuthorized: boolean;
  xlmBalance: string;
  spendableXlmBalance: string;
  lastCheckedAt: string | null;
}

interface TreasuryExportResponse {
  exportedAt: string;
  exportedBy: string;
  totalContributors: number;
  readyCount: number;
  notReadyCount: number;
  contributors: TreasuryExportItem[];
}

function toExportItem(reg: {
  stellarAddress: string;
  funded: boolean;
  trustlineReady: boolean;
  trustlineAuthorized: boolean;
  xlmBalance: string;
  spendableXlmBalance: string;
  lastCheckedAt: Date | null;
  user: { githubUsername: string };
}): TreasuryExportItem {
  const readiness = computeReadiness(
    reg.funded,
    reg.trustlineReady,
    reg.xlmBalance,
    {
      authorized: reg.trustlineAuthorized,
      spendableBalance: reg.spendableXlmBalance,
    }
  );

  return {
    githubUsername: reg.user.githubUsername,
    stellarAddress: reg.stellarAddress,
    readiness,
    funded: reg.funded,
    trustlineReady: reg.trustlineReady,
    trustlineAuthorized: reg.trustlineAuthorized,
    xlmBalance: reg.xlmBalance,
    spendableXlmBalance: reg.spendableXlmBalance,
    lastCheckedAt: reg.lastCheckedAt?.toISOString() ?? null,
  };
}

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);

  let actorId: string | null = null;
  let actorLogin: string | null = null;
  let exportedBy: string;

  if (session?.user?.id && session.user.isMaintainer) {
    actorId = session.user.id;
    actorLogin = session.user.githubUsername ?? null;
    exportedBy = session.user.email ?? session.user.githubUsername ?? "";
  } else {
    // Maintainer session absent — fall back to a scoped API key.
    const apiKeyAuth = await authenticateApiKey(request);
    if (!apiKeyAuth) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if ("rateLimited" in apiKeyAuth) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: buildRateLimitHeaders(
            apiKeyAuth.result,
            API_KEY_RATE_LIMIT.maxRequests
          ),
        }
      );
    }

    if (!hasScope(apiKeyAuth.scopes, "export:read")) {
      return insufficientScopeResponse("export:read");
    }

    actorId = apiKeyAuth.createdById;
    actorLogin = `api-key:${apiKeyAuth.name}`;
    exportedBy = actorLogin;
  }

  const pagination = parseExportPagination(request.nextUrl.searchParams);
  if (!pagination.ok) {
    return NextResponse.json({ error: pagination.error }, { status: 400 });
  }

  const { offset, limit } = pagination;

  const [countResult, registrations] = await Promise.all([
    prisma.registration?.count
      ? prisma.registration.count({ where: { deletedAt: null } }).catch(() => null)
      : Promise.resolve(null),
    prisma.registration.findMany({
      where: { deletedAt: null },
      orderBy: { id: "asc" },
      skip: offset,
      take: limit,
      include: {
        user: {
          select: {
            githubUsername: true,
          },
        },
      },
    }),
  ]);

  const totalContributors = countResult ?? registrations.length;
  const contributors = registrations.map(toExportItem);
  const readyCount = contributors.filter((c) => c.readiness === "ready").length;
  const notReadyCount = contributors.length - readyCount;
  const nextOffset = offset + contributors.length;
  const hasMore = nextOffset < totalContributors;

  await recordAuditLog({
    action: "treasury.export",
    actorId,
    actorLogin,
    metadata: {
      totalContributors,
      readyCount,
      notReadyCount,
      offset,
      limit,
    },
  });

  const response: TreasuryExportResponse & Record<string, unknown> & {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
  } = {
    exportedAt: new Date().toISOString(),
    exportedBy,
    totalContributors,
    readyCount,
    notReadyCount,
    contributors,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };

  return streamJsonExport(response);
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireOperator("treasury.export");
  let actorId: string;
  let actorLogin: string | null;
  if (session) {
    actorId = session.user.id;
    actorLogin = session.user.githubUsername ?? null;
  } else {
    const apiKeyAuth = await authenticateApiKey(request);
    if (!apiKeyAuth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    if ("rateLimited" in apiKeyAuth) {
      return NextResponse.json(
        { error: "Too many requests" },
        {
          status: 429,
          headers: buildRateLimitHeaders(
            apiKeyAuth.result,
            API_KEY_RATE_LIMIT.maxRequests
          ),
        }
      );
    }

    if (!hasScope(apiKeyAuth.scopes, "export:read")) {
      return insufficientScopeResponse("export:read");
    }

    actorId = apiKeyAuth.createdById;
    actorLogin = `api-key:${apiKeyAuth.name}`;
  }

  const body = (await request.json()) as {
    format?: string;
    snapshotAt?: string;
    offset?: number;
    limit?: number;
    blockWhenStale?: boolean;
    confirmStale?: boolean;
    allowStale?: boolean;
    overrideStale?: boolean;
  };
  const format = body.format ?? "json";

  if (format !== "json" && format !== "csv") {
    return NextResponse.json(
      { error: "Unsupported export format" },
      { status: 400 }
    );
  }

  const pagination = parseExportPagination({
    get: (key: string) => {
      const value = body[key as "offset" | "limit"];
      return value === undefined || value === null ? null : String(value);
    },
  });
  if (!pagination.ok) {
    return NextResponse.json({ error: pagination.error }, { status: 400 });
  }

  const { offset, limit } = pagination;

  const [countResult, registrations] = await Promise.all([
    prisma.registration?.count
      ? prisma.registration.count({ where: { deletedAt: null } }).catch(() => null)
      : Promise.resolve(null),
    prisma.registration.findMany({
      where: { deletedAt: null },
      orderBy: { id: "asc" },
      skip: offset,
      take: limit,
      include: {
        user: {
          select: {
            githubUsername: true,
          },
        },
      },
    }),
  ]);

  const totalContributors = countResult ?? registrations.length;
  const contributors = registrations.map(toExportItem);

  const blockWhenStale =
    body.blockWhenStale !== undefined
      ? body.blockWhenStale
      : !(body.confirmStale || body.allowStale || body.overrideStale);

  const staleGuard = evaluateStaleExportGuard(
    contributors as unknown as ContributorRow[],
    {
      snapshotAt: body.snapshotAt,
      blockWhenStale,
    }
  );

  if (staleGuard.blocked) {
    await recordAuditLog({
      action: "treasury.export.stale",
      actorId,
      actorLogin,
      metadata: {
        format,
        snapshotAt: body.snapshotAt ?? null,
        reason: staleGuard.reason ?? "stale_export",
        staleCount: staleGuard.staleCount,
        totalCount: staleGuard.totalCount,
      },
    });

    return NextResponse.json(
      {
        error:
          staleGuard.error ??
          staleGuard.warning ??
          "Export blocked due to stale data",
        reason: staleGuard.reason ?? "stale_export",
        stale: staleGuard.stale,
        staleCount: staleGuard.staleCount,
        totalCount: staleGuard.totalCount,
        stalePercent: staleGuard.stalePercent,
        warning: staleGuard.warning,
      },
      { status: 409 }
    );
  }

  const readyCount = contributors.filter((c) => c.readiness === "ready").length;
  const notReadyCount = contributors.length - readyCount;
  const nextOffset = offset + contributors.length;
  const hasMore = nextOffset < totalContributors;

  await recordAuditLog({
    action: "treasury.export",
    actorId,
    actorLogin,
    metadata: {
      totalContributors,
      readyCount,
      notReadyCount,
      format,
      offset,
      limit,
    },
  });

  if (format === "csv") {
    const headers = [
      "github_username",
      "stellar_address",
      "readiness",
      "funded",
      "trustline_ready",
      "trustline_authorized",
      "xlm_balance",
      "spendable_xlm_balance",
      "last_checked_at",
    ];

    const rows = contributors.map((c) => [
      c.githubUsername,
      c.stellarAddress,
      c.readiness,
      c.funded,
      c.trustlineReady,
      c.trustlineAuthorized,
      c.xlmBalance,
      c.spendableXlmBalance,
      c.lastCheckedAt ?? "",
    ]);

    const csv = buildCsv(headers, rows);

    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="${buildCsvFilename("treasury-export")}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const response: TreasuryExportResponse & Record<string, unknown> & {
    offset: number;
    limit: number;
    hasMore: boolean;
    nextOffset: number | null;
  } = {
    exportedAt: new Date().toISOString(),
    exportedBy:
      session?.user.email ?? session?.user.githubUsername ?? actorLogin ?? "",
    totalContributors,
    readyCount,
    notReadyCount,
    contributors,
    offset,
    limit,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };

  return streamJsonExport(response);
}
