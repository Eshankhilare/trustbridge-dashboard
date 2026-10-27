/**
 * InMemoryBackgroundQueue — lightweight in-process job queue for
 * fire-and-forget operations that must not block HTTP responses.
 *
 * Jobs move through a simple lifecycle:
 *   pending → processing → completed | dlq
 *
 * The dead-letter queue (DLQ) receives jobs that have exhausted their retry
 * budget. All state is in-memory; the queue does not survive a process
 * restart. For persistent scheduling, use the durable Prisma-backed
 * `BackgroundQueue` below with the same conceptual `enqueue` / `process` API.
 *
 * Thread-safety note: Node.js is single-threaded; concurrent reads of the
 * internal maps are safe. Mutations happen only inside the microtask that
 * processes a job, which cannot interleave with another job's mutation
 * within the same tick.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InMemoryJobStatus = "pending" | "processing" | "completed" | "dlq";

export interface InMemoryJob<T = unknown> {
  id: string;
  /** Arbitrary payload — not exposed externally to keep the API narrow. */
  payload: T;
  status: InMemoryJobStatus;
  /** ISO-8601 string set when the job is first enqueued. */
  enqueuedAt: string;
  /** ISO-8601 string set each time the job begins processing. */
  startedAt: string | null;
  /** ISO-8601 string set when the job reaches a terminal state. */
  finishedAt: string | null;
  /** Number of times this job has been attempted. */
  attempts: number;
  /** Last error message, if any. */
  lastError: string | null;
}

/** Shape returned by {@link InMemoryBackgroundQueue.getWorkerHealthMetrics}. */
export interface InMemoryWorkerHealthMetrics {
  /** Jobs awaiting their first (or next) processing attempt. */
  pendingCount: number;
  /** Jobs currently being processed. */
  processingCount: number;
  /** Jobs that finished successfully. */
  completedCount: number;
  /** Jobs that exhausted their retry budget and landed in the DLQ. */
  dlqCount: number;
  /** Total jobs ever enqueued (sum of all statuses). */
  totalEnqueued: number;
  /**
   * ISO-8601 timestamp of the most recently completed job, or null if no
   * job has ever completed.
   */
  lastProcessedAt: string | null;
  /**
   * ISO-8601 timestamp of when the queue instance was first created (i.e.
   * when the worker "started"), or null before any job has been enqueued.
   */
  workerStartedAt: string | null;
}

// ---------------------------------------------------------------------------
// BackgroundQueue
// ---------------------------------------------------------------------------

/**
 * Maximum number of times a job will be attempted before being moved to
 * the dead-letter queue. Deliberately kept small — these are supplementary
 * Horizon rechecks, not critical transactions.
 */
const DEFAULT_MAX_ATTEMPTS = 3;

let _idCounter = 0;

function nextJobId(): string {
  _idCounter += 1;
  return `job-${_idCounter}-${Date.now()}`;
}

export class InMemoryBackgroundQueue<T = unknown> {
  /** All jobs keyed by their id, regardless of status. */
  private readonly jobs = new Map<string, InMemoryJob<T>>();

  private lastProcessedAt: string | null = null;
  private workerStartedAt: string | null = null;
  private readonly maxAttempts: number;

  constructor(maxAttempts = DEFAULT_MAX_ATTEMPTS) {
    this.maxAttempts = maxAttempts;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Add a job to the pending queue. Returns the assigned job id.
   * The first enqueue also records the workerStartedAt timestamp.
   */
  enqueue(payload: T): string {
    const now = new Date().toISOString();
    if (!this.workerStartedAt) {
      this.workerStartedAt = now;
    }

    const id = nextJobId();
    const job: InMemoryJob<T> = {
      id,
      payload,
      status: "pending",
      enqueuedAt: now,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      lastError: null,
    };
    this.jobs.set(id, job);
    return id;
  }

  /**
   * Process the next pending job using the provided handler function.
   *
   * - Returns the job id if a job was found and executed (successfully or not).
   * - Returns `null` if the queue was empty.
   * - On failure, retries up to `maxAttempts` times before moving the job to
   *   the DLQ.
   *
   * This method is intentionally synchronous in its queue manipulation so
   * that the status transitions are visible to `getWorkerHealthMetrics`
   * immediately, even before the async handler resolves.
   */
  async process(handler: (payload: T) => Promise<void>): Promise<string | null> {
    const job = this.firstPending();
    if (!job) return null;

    const now = new Date().toISOString();
    job.status = "processing";
    job.startedAt = now;
    job.attempts += 1;

    try {
      await handler(job.payload);
      job.status = "completed";
      job.finishedAt = new Date().toISOString();
      this.lastProcessedAt = job.finishedAt;
    } catch (err) {
      job.lastError = err instanceof Error ? err.message : String(err);
      job.finishedAt = new Date().toISOString();

      if (job.attempts >= this.maxAttempts) {
        job.status = "dlq";
      } else {
        // Return to pending for retry
        job.status = "pending";
        job.finishedAt = null;
      }
    }

    return job.id;
  }

  /**
   * Return a read-only snapshot of all current job metrics. Safe to call
   * concurrently — does not mutate any internal state.
   */
  getWorkerHealthMetrics(): InMemoryWorkerHealthMetrics {
    let pendingCount = 0;
    let processingCount = 0;
    let completedCount = 0;
    let dlqCount = 0;

    for (const job of Array.from(this.jobs.values())) {
      switch (job.status) {
        case "pending":
          pendingCount++;
          break;
        case "processing":
          processingCount++;
          break;
        case "completed":
          completedCount++;
          break;
        case "dlq":
          dlqCount++;
          break;
      }
    }

    return {
      pendingCount,
      processingCount,
      completedCount,
      dlqCount,
      totalEnqueued: this.jobs.size,
      lastProcessedAt: this.lastProcessedAt,
      workerStartedAt: this.workerStartedAt,
    };
  }

  /**
   * Remove all jobs from all queues and reset timestamps.
   * Primarily intended for test isolation — do not call in production.
   */
  clear(): void {
    this.jobs.clear();
    this.lastProcessedAt = null;
    this.workerStartedAt = null;
  }

  /**
   * Return the count of jobs in a given status. Convenience accessor for
   * tests that need targeted assertions without reading the full metrics shape.
   */
  size(status?: InMemoryJobStatus): number {
    if (!status) return this.jobs.size;
    let count = 0;
    for (const job of Array.from(this.jobs.values())) {
      if (job.status === status) count++;
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private firstPending(): InMemoryJob<T> | undefined {
    for (const job of Array.from(this.jobs.values())) {
      if (job.status === "pending") return job;
    }
    return undefined;
  }
}

/**
 * Durable Prisma-backed queue (see below). The in-memory queue above is a
 * separate implementation — instantiate `InMemoryBackgroundQueue` directly;
 * there is no shared module-level singleton for it.
 */
import "server-only";

import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { redactString } from "@/lib/sentry";

/**
 * Upper bound on a stored job error string (issue #200). A stack trace or a
 * dumped payload can be arbitrarily large; cap it so the dead-letter queue
 * can't bloat the row or the DLQ API response.
 */
export const MAX_ERROR_LENGTH = 2000;

/**
 * Normalise an error before it is persisted on a failed job:
 *  - run it through the Sentry redactor so a contributor address / token /
 *    email in the message never lands in the DLQ
 *  - cap the length
 *  - fallback to "Unknown error" for empty/null/invalid inputs
 */
export function sanitizeJobError(raw?: string | null): string {
  if (!raw || typeof raw !== "string" || !raw.trim()) {
    return "Unknown error";
  }
  const redacted = redactString(raw);
  return redacted.length > MAX_ERROR_LENGTH
    ? `${redacted.slice(0, MAX_ERROR_LENGTH)}…[truncated]`
    : redacted;
}

export type JobType = "recheck.batch" | "recheck.single";
export type JobStatus = "pending" | "processing" | "completed" | "failed";

export interface Job {
  id: string;
  type: JobType;
  data: Record<string, unknown>;
  status: JobStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  result?: Record<string, unknown>;
  ownerId?: string;
}

export interface QueueMetrics {
  totalJobs: number;
  pendingCount: number;
  processingCount: number;
  completedCount: number;
  failedCount: number;
  averageProcessingTimeMs: number;
}

/**
 * Health snapshot returned by {@link BackgroundQueue.getWorkerHealthMetrics}
 * for the queue health endpoint.
 */
export interface QueueWorkerHealth {
  /** Number of jobs awaiting processing. */
  depth: number;
  /** Number of jobs in the dead-letter (failed) state. */
  failedCount: number;
  /** ISO-8601 creation time of the oldest pending job, if any. */
  oldestPendingJobCreatedAt: string | null;
  /** Always true: polling is constrained to request lifecycles serverless. */
  isServerlessInMemoryWarning: boolean;
}

export type JobHandler = (job: Job) => Promise<void>;

export class BackgroundQueue {
  private jobHandlers: Map<JobType, JobHandler> = new Map();
  private isRunning = false;
  private stopRequested = false;
  private pollIntervalMs: number;
  private maxConcurrency: number;

  constructor(options?: { pollIntervalMs?: number; maxConcurrency?: number }) {
    this.pollIntervalMs = options?.pollIntervalMs ?? 1000;
    this.maxConcurrency = options?.maxConcurrency ?? 2;
  }

  /**
   * Registers a worker handler for a specific job type.
   */
  registerHandler(type: JobType, handler: JobHandler): void {
    this.jobHandlers.set(type, handler);
  }

  /**
   * Enqueues a job durably to the database (QueueJob table).
   */
  async enqueue(
    type: JobType,
    data: Record<string, unknown>,
    ownerId?: string
  ): Promise<string> {
    const record = await prisma.queueJob.create({
      data: {
        type,
        status: "pending",
        data: data as never,
        ownerId: ownerId ?? null,
      },
    });

    return record.id;
  }

  /**
   * Retrieves a job by ID from the database.
   */
  async getJob(id: string): Promise<Job | undefined> {
    const record = await prisma.queueJob.findUnique({ where: { id } });
    if (!record) return undefined;

    return {
      id: record.id,
      type: record.type as JobType,
      data: (record.data as Record<string, unknown>) ?? {},
      status: record.status as JobStatus,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      error: record.error ?? undefined,
      result: (record.result as Record<string, unknown>) ?? undefined,
      ownerId: record.ownerId ?? undefined,
    };
  }

  /**
   * Retrieves current metrics across all jobs in the database.
   */
  async getMetrics(): Promise<QueueMetrics> {
    const [totalJobs, pendingCount, processingCount, completedCount, failedCount] =
      await Promise.all([
        prisma.queueJob.count(),
        prisma.queueJob.count({ where: { status: "pending" } }),
        prisma.queueJob.count({ where: { status: "processing" } }),
        prisma.queueJob.count({ where: { status: "completed" } }),
        prisma.queueJob.count({ where: { status: "failed" } }),
      ]);

    const recentJobs = await prisma.queueJob.findMany({
      where: {
        status: { in: ["completed", "failed"] },
        startedAt: { not: null },
        completedAt: { not: null },
      },
      orderBy: { completedAt: "desc" },
      take: 50,
      select: { startedAt: true, completedAt: true },
    });

    const averageProcessingTimeMs =
      recentJobs.length > 0
        ? recentJobs.reduce((sum, j) => {
            const ms = j.completedAt!.getTime() - j.startedAt!.getTime();
            return sum + ms;
          }, 0) / recentJobs.length
        : 0;

    return {
      totalJobs,
      pendingCount,
      processingCount,
      completedCount,
      failedCount,
      averageProcessingTimeMs,
    };
  }

  /**
   * Worker health snapshot for the queue health endpoint
   * (`GET /api/contributors/queue/health`). Response shape is pinned by
   * `src/app/api/contributors/queue/health/route.test.ts`.
   */
  async getWorkerHealthMetrics(): Promise<QueueWorkerHealth> {
    const [depth, failedCount, oldestPending] = await Promise.all([
      prisma.queueJob.count({ where: { status: "pending" } }),
      prisma.queueJob.count({ where: { status: "failed" } }),
      prisma.queueJob.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
    ]);

    return {
      depth,
      failedCount,
      oldestPendingJobCreatedAt:
        oldestPending?.createdAt.toISOString() ?? null,
      isServerlessInMemoryWarning: true,
    };
  }

  /**
   * Retrieves failed jobs for the dead-letter queue (issue #200).
   */
  async getFailedJobs(options?: {
    limit?: number;
    ownerId?: string;
  }): Promise<Job[]> {
    const limit = Math.min(Math.max(options?.limit ?? 50, 1), 200);

    const where: Prisma.QueueJobWhereInput = {
      status: "failed",
    };

    if (options?.ownerId) {
      where.OR = [{ ownerId: options.ownerId }, { ownerId: null }];
    }

    const records = await prisma.queueJob.findMany({
      where,
      orderBy: { completedAt: "desc" },
      take: limit,
    });

    return records.map((record) => ({
      id: record.id,
      type: record.type as JobType,
      data: (record.data as Record<string, unknown>) ?? {},
      status: record.status as JobStatus,
      createdAt: record.createdAt,
      startedAt: record.startedAt ?? undefined,
      completedAt: record.completedAt ?? undefined,
      error: record.error ?? undefined,
      result: (record.result as Record<string, unknown>) ?? undefined,
      ownerId: record.ownerId ?? undefined,
    }));
  }

  /**
   * Retries a failed job by resetting its status to pending (issue #200).
   */
  async retryJob(
    id: string,
    options?: { ownerId?: string }
  ): Promise<Job | null> {
    const existing = await prisma.queueJob.findUnique({ where: { id } });
    if (!existing || existing.status !== "failed") {
      return null;
    }

    if (options?.ownerId && existing.ownerId && existing.ownerId !== options.ownerId) {
      return null;
    }

    const existingData = (existing.data as Record<string, unknown>) ?? {};
    const retries =
      typeof existingData.__retries === "number" ? existingData.__retries : 0;
    const nextData = { ...existingData, __retries: retries + 1 };

    const updated = await prisma.queueJob.update({
      where: { id },
      data: {
        status: "pending",
        error: null,
        startedAt: null,
        completedAt: null,
        data: nextData as never,
      },
    });

    return {
      id: updated.id,
      type: updated.type as JobType,
      data: (updated.data as Record<string, unknown>) ?? {},
      status: updated.status as JobStatus,
      createdAt: updated.createdAt,
      startedAt: updated.startedAt ?? undefined,
      completedAt: updated.completedAt ?? undefined,
      error: updated.error ?? undefined,
      result: (updated.result as Record<string, unknown>) ?? undefined,
      ownerId: updated.ownerId ?? undefined,
    };
  }

  /**
   * Atomically claims the next pending job from PostgreSQL to prevent double processing.
   */
  async claimNextPendingJob(): Promise<Job | null> {
    // Find oldest pending job
    const candidate = await prisma.queueJob.findFirst({
      where: { status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (!candidate) return null;

    // Atomically claim by updating status from pending -> processing
    const now = new Date();
    const updated = await prisma.queueJob.updateMany({
      where: {
        id: candidate.id,
        status: "pending",
      },
      data: {
        status: "processing",
        startedAt: now,
      },
    });

    if (updated.count === 0) {
      // Race condition: another worker claimed it first
      return null;
    }

    const claimedRecord = await prisma.queueJob.findUnique({
      where: { id: candidate.id },
    });

    if (!claimedRecord) return null;

    return {
      id: claimedRecord.id,
      type: claimedRecord.type as JobType,
      data: (claimedRecord.data as Record<string, unknown>) ?? {},
      status: "processing",
      createdAt: claimedRecord.createdAt,
      startedAt: now,
      ownerId: claimedRecord.ownerId ?? undefined,
    };
  }

  /**
   * Processes a single claimed job.
   */
  async processJob(job: Job): Promise<void> {
    const handler = this.jobHandlers.get(job.type);

    if (!handler) {
      const errorMsg = `No handler registered for job type: ${job.type}`;
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: sanitizeJobError(errorMsg),
        },
      });
      return;
    }

    try {
      await handler(job);

      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "completed",
          completedAt: new Date(),
          result: (job.result as never) ?? null,
        },
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      await prisma.queueJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          error: sanitizeJobError(errorMsg),
        },
      });
      console.error(`[QueueWorker] Job ${job.id} failed:`, errorMsg);
    }
  }

  /**
   * Runs the worker loop continuously until stop() is called.
   */
  async startWorkerLoop(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.stopRequested = false;

    console.log("[QueueWorker] Background worker loop started.");

    while (!this.stopRequested) {
      try {
        const job = await this.claimNextPendingJob();
        if (job) {
          await this.processJob(job);
        } else {
          // No pending jobs, sleep for poll interval
          await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        }
      } catch (error) {
        console.error("[QueueWorker] Worker loop error:", error);
        await new Promise((resolve) => setTimeout(resolve, Math.max(this.pollIntervalMs, 3000)));
      }
    }

    this.isRunning = false;
    console.log("[QueueWorker] Background worker loop stopped.");
  }

  /**
   * Signals the worker loop to stop gracefully.
   */
  stop(): void {
    this.stopRequested = true;
  }
}

export const backgroundQueue = new BackgroundQueue();
