import "server-only";

import type { Prisma } from "@prisma/client";

import { toAuditLogEntry } from "@/lib/audit-format";
import type { AuditAction, AuditLogEntry } from "@/types";

export interface RecordAuditInput {
  action: AuditAction | string;
  actorId?: string | null;
  actorLogin?: string | null;
  targetId?: string | null;
  targetLabel?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Load Prisma lazily so Edge middleware can import this module without pulling
 * the Prisma client into the Edge runtime bundle. Audit writes from Edge
 * middleware remain best-effort and fail without blocking the request.
 */
async function getPrisma() {
  const { prisma } = await import("@/lib/prisma");
  return prisma;
}

/**
 * Persist a maintainer action to the audit log.
 *
 * Auditing is best-effort: a logging failure must never break the primary
 * action, so errors are swallowed (and surfaced to the server console).
 */
export async function recordAuditLog(input: RecordAuditInput): Promise<void> {
  try {
    const prisma = await getPrisma();
    await prisma.auditLog.create({
      data: {
        action: input.action,
        actorId: input.actorId ?? null,
        actorLogin: input.actorLogin ?? null,
        targetId: input.targetId ?? null,
        targetLabel: input.targetLabel ?? null,
        metadata:
          (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
  } catch (error) {
    console.error("[audit] failed to record audit log", input.action, error);
  }
}

/**
 * Record a pubnet/testnet switch performed from settings.
 *
 * Wraps {@link recordAuditLog} with the canonical action name and a stable
 * metadata shape so the network switch trail stays consistent across call
 * sites. Best-effort like the underlying helper.
 */
export async function recordNetworkSwitchAudit(input: {
  actorId?: string | null;
  actorLogin?: string | null;
  fromNetwork: string;
  toNetwork: string;
  confirmed: boolean;
}): Promise<void> {
  await recordAuditLog({
    action: "settings.network.switch",
    actorId: input.actorId ?? null,
    actorLogin: input.actorLogin ?? null,
    targetId: input.toNetwork,
    targetLabel: input.toNetwork,
    metadata: {
      fromNetwork: input.fromNetwork,
      toNetwork: input.toNetwork,
      confirmed: input.confirmed,
    },
  });
}

/**
 * Persist a maintainer action to the audit log, surfacing failures.
 *
 * Unlike {@link recordAuditLog}, this variant rejects when the audit write
 * fails. Use it for privileged flows (e.g. ban appeal notes) where an
 * unaudited action must not be allowed to succeed.
 */
export async function recordAuditLogStrict(
  input: RecordAuditInput,
): Promise<void> {
  const prisma = await getPrisma();
  await prisma.auditLog.create({
    data: {
      action: input.action,
      actorId: input.actorId ?? null,
      actorLogin: input.actorLogin ?? null,
      targetId: input.targetId ?? null,
      targetLabel: input.targetLabel ?? null,
      metadata:
        (input.metadata as Prisma.InputJsonValue | undefined) ?? undefined,
    },
  });
}

/** Read the most recent audit log entries, newest first. */
export async function getRecentAuditLog(limit = 50): Promise<AuditLogEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
  const prisma = await getPrisma();
  const rows = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return rows.map(toAuditLogEntry);
}
