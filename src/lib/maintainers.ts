import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";

export interface MaintainerNoteInput {
  registrationId: string;
  note: string;
  authorId?: string;
  authorLogin?: string;
  maintainerOrgId?: string;
}

export interface ConflictSummary {
  id: string;
  attemptedAddress: string;
  attemptedUserId: string;
  existingUserId: string;
  createdAt: Date;
  maintainerOrgId: string;
}

export interface MaintainerContext {
  userId?: string;
  maintainerOrgId: string;
  isMaintainer: boolean;
  role?: string;
}

/**
 * Checks if a user has maintainer privileges.
 */
export async function isMaintainer(
  user?: { isMaintainer?: boolean; role?: string } | null
): Promise<boolean> {
  return Boolean(user?.isMaintainer);
}

/**
 * Auth sources `getMaintainerContext` understands: a NextAuth session user
 * or an API-key auth record.
 */
export type MaintainerAuthSource =
  | {
      user?: {
        id?: string;
        maintainerOrgId?: string;
        isMaintainer?: boolean;
        role?: string;
      } | null;
    }
  | {
      maintainerOrgId?: string;
      keyId?: string;
      createdById?: string;
      id?: string;
      role?: string;
    }
  | null
  | undefined;

/**
 * Resolves maintainer context from a session or API key auth source,
 * ensuring consistent org scoping across both auth paths.
 */
export function getMaintainerContext(
  authSource?: MaintainerAuthSource
): MaintainerContext {
  if (!authSource) {
    return { maintainerOrgId: "default", isMaintainer: false };
  }

  // NextAuth Session format
  if ("user" in authSource && authSource.user) {
    return {
      userId: authSource.user.id,
      maintainerOrgId: authSource.user.maintainerOrgId ?? "default",
      isMaintainer: Boolean(authSource.user.isMaintainer),
      role: authSource.user.role,
    };
  }

  // API Key auth format — requires a truthy org, key id, or creator id.
  if (
    ("maintainerOrgId" in authSource && authSource.maintainerOrgId) ||
    ("keyId" in authSource && authSource.keyId) ||
    ("createdById" in authSource && authSource.createdById)
  ) {
    return {
      userId: authSource.createdById ?? authSource.id,
      maintainerOrgId: authSource.maintainerOrgId ?? "default",
      isMaintainer: true,
      role: authSource.role ?? "operator",
    };
  }

  return { maintainerOrgId: "default", isMaintainer: false };
}

/**
 * Appends a maintainer note to an active registration.
 * Rejects empty notes to avoid accidental overwrites.
 * Rejects notes on soft-deleted registrations.
 */
export async function appendRegistrationNote(input: MaintainerNoteInput) {
  if (!input.registrationId) {
    throw new Error("registrationId is required");
  }

  const trimmedNote = input.note ? input.note.trim() : "";
  if (!trimmedNote) {
    // Empty note strings should not overwrite existing notes unintentionally
    return null;
  }

  const whereClause: Prisma.RegistrationWhereInput = {
    id: input.registrationId,
  };
  if (input.maintainerOrgId) {
    whereClause.maintainerOrgId = input.maintainerOrgId;
  }

  const registration = await prisma.registration.findFirst({
    where: whereClause,
  });

  if (!registration) {
    return null;
  }

  if (registration.deletedAt !== null) {
    throw new Error("Cannot append note to a soft-deleted registration");
  }

  const existingNotes = registration.notes ? registration.notes.trim() : "";
  const updatedNotes = existingNotes
    ? `${existingNotes}\n${trimmedNote}`
    : trimmedNote;

  const updated = await prisma.registration.update({
    where: { id: registration.id },
    data: { notes: updatedNotes },
  });

  await recordAuditLog({
    action: "registration.note_update",
    actorId: input.authorId ?? null,
    actorLogin: input.authorLogin ?? null,
    targetId: registration.id,
    targetLabel: registration.stellarAddress,
    metadata: {
      note: trimmedNote,
      previousNotes: registration.notes,
      maintainerOrgId: input.maintainerOrgId ?? registration.maintainerOrgId,
    },
  });

  return updated;
}

/**
 * Records a registration conflict when a user tries to register an address
 * already registered to another user, and logs an audit record.
 */
export async function recordRegistrationConflict(input: {
  attemptedAddress: string;
  attemptedUserId: string;
  existingUserId: string;
  maintainerOrgId?: string;
  actorLogin?: string;
  existingRegistrationId?: string;
}) {
  const orgId = input.maintainerOrgId ?? "default";
  let conflict: { id: string } | null = null;

  try {
    conflict = await prisma.registrationConflict.create({
      data: {
        attemptedAddress: input.attemptedAddress,
        attemptedUserId: input.attemptedUserId,
        existingUserId: input.existingUserId,
        maintainerOrgId: orgId,
      },
    });
  } catch (err) {
    console.error("Failed to record RegistrationConflict:", err);
  }

  await recordAuditLog({
    action: "registration.conflict",
    actorId: input.attemptedUserId,
    actorLogin: input.actorLogin ?? null,
    targetId: input.existingRegistrationId ?? conflict?.id ?? null,
    targetLabel: input.attemptedAddress,
    metadata: {
      attemptedAddress: input.attemptedAddress,
      maintainerOrgId: orgId,
    },
  });

  return conflict;
}

/**
 * Lists open registration conflicts scoped by maintainerOrgId.
 */
export async function listRegistrationConflicts(options?: {
  maintainerOrgId?: string;
  limit?: number;
}): Promise<ConflictSummary[]> {
  const where: Prisma.RegistrationConflictWhereInput = {};
  if (options?.maintainerOrgId) {
    where.maintainerOrgId = options.maintainerOrgId;
  }

  return prisma.registrationConflict.findMany({
    where: Object.keys(where).length > 0 ? where : undefined,
    orderBy: { createdAt: "desc" },
    take: options?.limit ?? 100,
  });
}

/**
 * Lists soft-deleted registrations with cursor pagination and maintainerOrgId filtering.
 */
export async function listDeletedRegistrations(options?: {
  maintainerOrgId?: string;
  limit?: number;
  cursor?: string;
}) {
  const limit = options?.limit ?? 25;
  const cursor = options?.cursor;

  const { encodeCursor, decodeCursor } = await import("@/lib/cursor-pagination");
  const decodedCursor = cursor ? decodeCursor(cursor) : null;

  const where: Prisma.RegistrationWhereInput = { deletedAt: { not: null } };
  if (options?.maintainerOrgId) {
    where.maintainerOrgId = options.maintainerOrgId;
  }

  const registrations = await prisma.registration.findMany({
    where,
    include: {
      user: {
        select: { githubUsername: true },
      },
    },
    orderBy: { deletedAt: "desc" },
    ...(decodedCursor && {
      skip: 1,
      cursor: { id: decodedCursor },
    }),
    take: limit + 1,
  });

  const hasMore = registrations.length > limit;
  const pageData = registrations.slice(0, limit);
  const nextCursor = hasMore
    ? encodeCursor(pageData[pageData.length - 1].id)
    : null;

  return {
    registrations: pageData.map((reg) => ({
      id: reg.id,
      stellarAddress: reg.stellarAddress,
      userId: reg.userId,
      githubUsername: reg.user?.githubUsername ?? null,
      deletedAt: reg.deletedAt,
      createdAt: reg.createdAt,
      updatedAt: reg.updatedAt,
    })),
    hasMore,
    nextCursor: nextCursor ?? undefined,
  };
}
