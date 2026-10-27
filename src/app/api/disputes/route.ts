import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/csrf";
import { invalidateContributorListCaches } from "@/lib/cache-tags";
import { prisma } from "@/lib/prisma";
import {
  trackServerDisputeClosed,
  trackServerDisputeOpened,
} from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const createSchema = z.object({
  registrationId: z.string().min(1),
  reason: z.string().trim().min(1).max(2_000),
  proofCid: z.string().trim().max(200).optional(),
});

const updateSchema = z.object({
  disputeId: z.string().min(1),
  status: z.enum(["VALIDATED", "REJECTED"]),
});

const DEFAULT_DISPUTES_LIMIT = 25;
const MAX_DISPUTES_LIMIT = 100;

export async function GET(request: NextRequest) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const searchParams = request.nextUrl.searchParams;
  const registrationId = searchParams.get("registrationId");
  const status = searchParams.get("status");
  const cursor = searchParams.get("cursor") ?? undefined;

  const limitParam = searchParams.get("limit");
  let limit = DEFAULT_DISPUTES_LIMIT;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0) {
      // Clamp to the maximum instead of falling back, so an explicit
      // over-max request still returns the largest allowed page.
      limit = Math.min(parsed, MAX_DISPUTES_LIMIT);
    }
  }

  const where = {
    ...(registrationId ? { registrationId } : {}),
    ...(status && ["OPEN", "VALIDATED", "REJECTED"].includes(status)
      ? { status: status as "OPEN" | "VALIDATED" | "REJECTED" }
      : {}),
    ...(session.user.isMaintainer ? {} : { registration: { userId: session.user.id } }),
  };

  const { encodeCursor, decodeCursor } = await import("@/lib/cursor-pagination");
  const decodedCursor = cursor ? decodeCursor(cursor) : null;

  const disputes = await prisma.disputeProof.findMany({
    where,
    select: {
      id: true,
      registrationId: true,
      reason: true,
      proofCid: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
    },
    orderBy: { createdAt: "desc" },
    ...(decodedCursor && {
      skip: 1,
      cursor: { id: decodedCursor },
    }),
    take: limit + 1,
  });

  const hasMore = disputes.length > limit;
  const pageData = disputes.slice(0, limit);
  const nextCursor = hasMore
    ? encodeCursor(pageData[pageData.length - 1].id)
    : null;

  return NextResponse.json({
    disputes: pageData,
    hasMore,
    nextCursor: nextCursor ?? undefined,
  });
}

export async function POST(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid dispute details" }, { status: 400 });
  }

  const registration = await prisma.registration.findUnique({
    where: { id: parsed.data.registrationId },
    select: { id: true, userId: true },
  });
  if (!registration || (!session.user.isMaintainer && registration.userId !== session.user.id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const existing = await prisma.disputeProof.findUnique({
    where: { registrationId: registration.id },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json({ error: "A dispute already exists for this registration" }, { status: 409 });
  }

  const dispute = await prisma.disputeProof.create({
    data: {
      registrationId: registration.id,
      reason: parsed.data.reason,
      proofCid: parsed.data.proofCid || null,
    },
    select: { id: true, registrationId: true, reason: true, proofCid: true, status: true, createdAt: true },
  });
  trackServerDisputeOpened({
    userId: session.user.id,
    disputeId: dispute.id,
    registrationId: dispute.registrationId,
    actorRole: session.user.isMaintainer ? "maintainer" : "contributor",
    hasProof: Boolean(dispute.proofCid),
  });
  return NextResponse.json({ dispute }, { status: 201 });
}

export async function PATCH(request: NextRequest) {
  const csrf = assertSameOrigin(request);
  if (csrf) return csrf;

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!session.user.isMaintainer) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = updateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid dispute update" }, { status: 400 });
  }

  const dispute = await prisma.disputeProof.findUnique({
    where: { id: parsed.data.disputeId },
    select: { id: true, status: true },
  });

  if (!dispute) {
    return NextResponse.json({ error: "Dispute not found" }, { status: 404 });
  }

  const updated = await prisma.disputeProof.update({
    where: { id: parsed.data.disputeId },
    data: {
      status: parsed.data.status,
      resolvedAt: new Date(),
    },
    select: {
      id: true,
      registrationId: true,
      reason: true,
      proofCid: true,
      status: true,
      createdAt: true,
      updatedAt: true,
      resolvedAt: true,
    },
  });

  if (dispute.status === "OPEN") {
    trackServerDisputeClosed({
      userId: session.user.id,
      disputeId: updated.id,
      // `parsed.data.status` is validated as VALIDATED | REJECTED above, so
      // prefer it over `updated.status` (typed as the full enum).
      status: parsed.data.status,
    });
  }

  await invalidateContributorListCaches();

  return NextResponse.json({ dispute: updated });
}