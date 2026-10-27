import "server-only";

import type { Prisma } from "@prisma/client";

import { InMemoryBackgroundQueue } from "@/lib/background-queue";
import { logger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { recordAuditLog } from "@/lib/audit";
import { redactString } from "@/lib/sentry";
import {
  mirrorRegistrationToSoroban,
  type MirrorRegistrationPayload,
  type MirrorResult,
} from "@/lib/soroban-register";

/**
 * Soroban outbox worker.
 *
 * Consumes `MirrorRegistrationPayload` jobs from the background queue and
 * delegates each one to `mirrorRegistrationToSoroban`. Failures are logged
 * (not re-thrown) — the queue handles retries up to the configured
 * `maxAttempts`, after which the job lands in the DLQ.
 *
 * The worker is designed to be called from a lightweight server-side
 * interval or a Next.js Route Handler that acts as a heartbeat.
 * It processes **one job per tick** so that each tick is fast and does not
 * monopolize the event loop.
 *
 * Usage (fire-and-forget from /api/register or a cron route):
 * ```ts
 * import { tickSorobanOutboxWorker } from "@/lib/soroban-outbox-worker";
 * void tickSorobanOutboxWorker();
 * ```
 */

const workerLogger = logger.child({ subsystem: "soroban-outbox-worker" });

/**
 * Dedicated in-process queue for Soroban mirror jobs. The durable
 * Prisma-backed `backgroundQueue` singleton serves the recheck worker loop;
 * mirror jobs are lightweight and live only for the process lifetime.
 */
const inMemoryQueue = new InMemoryBackgroundQueue<MirrorRegistrationPayload>();

/**
 * Process the next pending Soroban mirror job, if any.
 * Returns the job id that was processed, or null if the queue was empty.
 */
export async function tickSorobanOutboxWorker(): Promise<string | null> {
  return inMemoryQueue.process(async (payload) => {
    const typed = payload as MirrorRegistrationPayload;

    workerLogger.info("soroban_outbox_tick", {
      registrationId: typed.registrationId,
    });

    const result = await mirrorRegistrationToSoroban(typed);

    if (!result.success) {
      workerLogger.error("soroban_outbox_job_failed", {
        registrationId: typed.registrationId,
        error: result.error,
      });
      // Re-throw so the queue can record the failure and decide on retry/DLQ.
      throw new Error(
        typeof result.error?.message === "string"
          ? (result.error.message as string)
          : "Soroban mirror failed"
      );
    }

    workerLogger.info("soroban_outbox_job_done", {
      registrationId: typed.registrationId,
      skipped: "skipped" in result ? result.skipped : false,
    });
  });
}

/**
 * Enqueue a registration payload for asynchronous Soroban mirroring.
 * Call this after a successful `prisma.registration.upsert()`.
 */
export function enqueueSorobanMirror(payload: MirrorRegistrationPayload): string {
  workerLogger.info("soroban_mirror_enqueued", {
    registrationId: payload.registrationId,
    stellarAddress: payload.stellarAddress,
  });
  return inMemoryQueue.enqueue(payload);
}

const MAX_OUTBOX_ERROR_LENGTH = 2000;

function sanitizeOutboxError(error: string | null | undefined): string | null {
  if (!error) return null;
  const redacted = redactString(error);
  return redacted.length > MAX_OUTBOX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_OUTBOX_ERROR_LENGTH)}...[truncated]`
    : redacted;
}

export interface OutboxProcessOptions {
  batchSize?: number;
  maxAttempts?: number;
  maintainerOrgId?: string;
  entryId?: string;
}

export interface SorobanOutboxDeadLetter {
  id: string;
  action: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SorobanOutboxMetrics {
  total: number;
  pending: number;
  processing: number;
  completed: number;
  failed: number;
}

export async function listSorobanOutboxDeadLetters(
  maintainerOrgId: string,
  limit = 50
): Promise<SorobanOutboxDeadLetter[]> {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 200);
  const rows = await prisma.sorobanOutbox.findMany({
    where: { maintainerOrgId, status: "FAILED" },
    select: {
      id: true,
      action: true,
      attempts: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "desc" },
    take: safeLimit,
  });

  return rows.map((row) => ({
    ...row,
    lastError: sanitizeOutboxError(row.lastError),
  }));
}

export async function replayFailedSorobanOutboxEntry(
  id: string,
  maintainerOrgId: string
): Promise<{ id: string; action: string; previousAttempts: number } | null> {
  const failedEntry = await prisma.sorobanOutbox.findFirst({
    where: { id, maintainerOrgId, status: "FAILED" },
    select: { id: true, action: true, attempts: true },
  });
  if (!failedEntry) return null;

  const updated = await prisma.sorobanOutbox.updateMany({
    where: { id, maintainerOrgId, status: "FAILED" },
    data: {
      status: "PENDING",
      attempts: 0,
      lastError: null,
      nextAttemptAt: new Date(),
    },
  });
  if (updated.count !== 1) return null;

  return {
    id: failedEntry.id,
    action: failedEntry.action,
    previousAttempts: failedEntry.attempts,
  };
}

export async function getSorobanOutboxMetrics(
  maintainerOrgId?: string
): Promise<SorobanOutboxMetrics> {
  const whereScope = maintainerOrgId ? { maintainerOrgId } : {};
  const [total, pending, processing, completed, failed] = await Promise.all([
    prisma.sorobanOutbox.count({ where: whereScope }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "PENDING" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "PROCESSING" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "COMPLETED" } }),
    prisma.sorobanOutbox.count({ where: { ...whereScope, status: "FAILED" } }),
  ]);

  return { total, pending, processing, completed, failed };
}

export async function processSorobanOutbox(options: OutboxProcessOptions = {}) {
  const batchSize = options.batchSize ?? 10;
  const maxAttempts = options.maxAttempts ?? 5;

  const where: Prisma.SorobanOutboxWhereInput = {
    status: "PENDING",
    nextAttemptAt: { lte: new Date() },
  };
  if (options.entryId) {
    where.id = options.entryId;
  }
  if (options.maintainerOrgId) {
    where.maintainerOrgId = options.maintainerOrgId;
  }

  const pending = await prisma.sorobanOutbox.findMany({
    where,
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let processedCount = 0;
  let successCount = 0;
  let failedCount = 0;

  for (const item of pending) {
    const claim = await prisma.sorobanOutbox.updateMany({
      where: { id: item.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    });
    if (claim.count !== 1) continue;
    processedCount++;

    const payload = item.payload as { stellarAddress: string; githubUsername: string; registrationId: string };

    let result: MirrorResult;
    try {
      result = await mirrorRegistrationToSoroban({
        githubUsername: payload.githubUsername,
        stellarAddress: payload.stellarAddress,
        registrationId: payload.registrationId,
      });
    } catch (error) {
      result = {
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }

    if (result.success) {
      successCount++;
      await prisma.sorobanOutbox.update({
        where: { id: item.id },
        data: {
          status: "COMPLETED",
          updatedAt: new Date(),
        },
      });
    } else {
      const nextAttempts = item.attempts + 1;
      const isFinalFailure = nextAttempts >= maxAttempts;
      const lastError =
        sanitizeOutboxError(JSON.stringify(result.error)) ?? "Unknown error";

      if (isFinalFailure) {
        failedCount++;
        await prisma.sorobanOutbox.update({
          where: { id: item.id },
          data: {
            status: "FAILED",
            attempts: nextAttempts,
            lastError,
            updatedAt: new Date(),
          },
        });

        await recordAuditLog({
          action: "soroban_outbox_exhausted",
          actorId: item.maintainerOrgId,
          targetId: item.id,
          metadata: { action: item.action, attempts: nextAttempts, error: lastError },
        });
      } else {
        // Exponential backoff retry: 5s, 25s, 125s...
        const backoffMs = Math.pow(5, nextAttempts) * 1000;
        const nextAttemptAt = new Date(Date.now() + backoffMs);

        await prisma.sorobanOutbox.update({
          where: { id: item.id },
          data: {
            status: "PENDING",
            attempts: nextAttempts,
            lastError,
            nextAttemptAt,
            updatedAt: new Date(),
          },
        });
      }
    }
  }

  return {
    processedCount,
    successCount,
    failedCount,
  };
}
