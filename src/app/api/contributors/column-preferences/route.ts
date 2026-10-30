import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

import { requireMaintainerSession } from "@/lib/api-auth";
import {
  defaultContributorColumnPreferences,
  validateContributorColumnPreferences,
  type ContributorColumnPreference,
} from "@/lib/contributors";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store, max-age=0" };

/**
 * Preferences are always scoped from the server-side session, never from the
 * request body. A maintainer cannot read or write another user's preferences,
 * and switching orgs reads a different row.
 */
function preferenceScope(session: {
  user: { id: string; maintainerOrgId?: string };
}) {
  return {
    userId: session.user.id,
    maintainerOrgId: session.user.maintainerOrgId ?? "default",
  };
}

function responseBody(
  columns: ContributorColumnPreference[],
  options: { isDefault: boolean; updatedAt?: Date | string | null },
) {
  return {
    columns,
    isDefault: options.isDefault,
    updatedAt:
      options.updatedAt instanceof Date
        ? options.updatedAt.toISOString()
        : options.updatedAt ?? null,
  };
}

/**
 * GET /api/contributors/column-preferences
 *
 * Returns the current maintainer's saved contributor-table preferences for the
 * active org. Falls back to the default column set when nothing has been saved
 * or when the stored value is no longer valid.
 */
export async function GET() {
  const session = await requireMaintainerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const scope = preferenceScope(session);

  try {
    const saved = await prisma.contributorColumnPreference.findUnique({
      where: {
        userId_maintainerOrgId: {
          userId: scope.userId,
          maintainerOrgId: scope.maintainerOrgId,
        },
      },
    });

    if (!saved) {
      return NextResponse.json(
        responseBody(defaultContributorColumnPreferences(), {
          isDefault: true,
        }),
        { headers: NO_STORE_HEADERS },
      );
    }

    const validated = validateContributorColumnPreferences(saved.columns);

    if (!validated.valid) {
      return NextResponse.json(
        responseBody(defaultContributorColumnPreferences(), {
          isDefault: true,
        }),
        { headers: NO_STORE_HEADERS },
      );
    }

    return NextResponse.json(
      responseBody(validated.preferences, {
        isDefault: false,
        updatedAt: saved.updatedAt,
      }),
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to load column preferences" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}

/**
 * PUT /api/contributors/column-preferences
 *
 * Replaces the current maintainer's saved column visibility and order for the
 * active org. The body must contain `{ columns: [{ key, visible }, ...] }`
 * listing every known column exactly once.
 */
export async function PUT(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await requireMaintainerSession();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  const submitted =
    body && typeof body === "object" && "columns" in body
      ? (body as { columns?: unknown }).columns
      : undefined;

  const validated = validateContributorColumnPreferences(submitted);
  if (!validated.valid) {
    return NextResponse.json(
      {
        error: "Invalid column preferences",
        details: validated.errors,
      },
      { status: 400 },
    );
  }

  const scope = preferenceScope(session);

  try {
    const saved = await prisma.contributorColumnPreference.upsert({
      where: {
        userId_maintainerOrgId: {
          userId: scope.userId,
          maintainerOrgId: scope.maintainerOrgId,
        },
      },
      create: {
        userId: scope.userId,
        maintainerOrgId: scope.maintainerOrgId,
        columns: validated.preferences as unknown as Prisma.InputJsonValue,
      },
      update: {
        columns: validated.preferences as unknown as Prisma.InputJsonValue,
      },
    });

    return NextResponse.json(
      responseBody(validated.preferences, {
        isDefault: false,
        updatedAt: saved.updatedAt,
      }),
      { headers: NO_STORE_HEADERS },
    );
  } catch {
    return NextResponse.json(
      { error: "Failed to save column preferences" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
