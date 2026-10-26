import { NextRequest, NextResponse } from "next/server";

import { requireOperator } from "@/lib/api-auth";
import { recordAuditLog } from "@/lib/audit";
import { assertSameOrigin } from "@/lib/csrf";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// DELETE  /api/settings/api-keys/[id]  — revoke (soft-delete) a key
// ---------------------------------------------------------------------------

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const csrfError = assertSameOrigin(request);
  if (csrfError) {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }

  const session = await requireOperator("api_key.revoke");
  if (!session) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = params;

  // Fetch first to ensure the key belongs to the current user (prevents
  // cross-maintainer revocation even within the same org).
  const key = await prisma.apiKey.findUnique({
    where: { id },
    select: { id: true, name: true, createdById: true, revokedAt: true },
  });

  if (!key) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (key.createdById !== session.user.id) {
    await recordAuditLog({
      action: "api_key.revoke_denied",
      actorId: session.user.id,
      actorLogin: session.user.githubUsername ?? null,
      targetId: id,
      metadata: { reason: "not_owner" },
    });
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (key.revokedAt) {
    return NextResponse.json({ error: "Key is already revoked" }, { status: 409 });
  }

  await prisma.apiKey.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  await recordAuditLog({
    action: "api_key.revoked",
    actorId: session.user.id,
    actorLogin: session.user.githubUsername ?? null,
    targetId: id,
    targetLabel: key.name,
    metadata: { keyName: key.name },
  });

  return NextResponse.json({ success: true });
}
