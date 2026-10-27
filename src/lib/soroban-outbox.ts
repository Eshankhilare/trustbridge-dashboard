import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

/**
 * Unified Soroban outbox adapter (Issue #488).
 *
 * Two complementary paths share one entry point:
 *
 * - **Production path** (`maintainerOrgId` present, no sink configured):
 *   persists via `prisma.sorobanOutbox.create` with status `PENDING` so the
 *   worker can claim and deliver the row.
 * - **In-memory path** (a sink is configured, or neither sink nor org is):
 *   keeps entries in a process-local Map. Used by tests and by the local
 *   worker loop; a delivered entry becomes `COMPLETED`, a throwing sink
 *   marks it `FAILED` (attempts + 1) and rethrows.
 *
 * Statuses are UPPERCASE to match the persisted rows the worker writes
 * (`PENDING` / `COMPLETED` / `FAILED`).
 */
export type SorobanOutboxStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED";

export interface SorobanOutboxEntry {
  id: string;
  payload: unknown;
  status: SorobanOutboxStatus;
  attempts: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueSorobanOutboxOptions {
  /** Optional idempotency key so retries do not duplicate the mirror. */
  idempotencyKey?: string;
  /** Optional sink override, primarily for tests. */
  sink?: SorobanOutboxSink;
  /** Owning maintainer org. Present => persist via Prisma (production). */
  maintainerOrgId?: string;
  /** Outbox action discriminator. Defaults to "register". */
  action?: string;
}

export type SorobanOutboxSink = (
  entry: SorobanOutboxEntry,
) => Promise<void> | void;

const outbox = new Map<string, SorobanOutboxEntry>();

let sink: SorobanOutboxSink | undefined;

/**
 * Register the process-wide sink used to deliver outbox entries to Soroban.
 * The worker (scripts/worker.mjs) drains the same store via the exported
 * helpers below; keeping a single sink avoids a parallel subsystem.
 */
export function setSorobanOutboxSink(next?: SorobanOutboxSink): void {
  sink = next;
}

/**
 * Enqueue a Soroban mirror payload for asynchronous delivery.
 *
 * Failures are surfaced (thrown) rather than swallowed so callers such as the
 * register route can report a real error instead of a silent no-op.
 */
export async function enqueueSorobanOutbox(
  payload: unknown,
  options: EnqueueSorobanOutboxOptions = {},
): Promise<SorobanOutboxEntry> {
  if (payload === undefined || payload === null) {
    throw new Error("enqueueSorobanOutbox: payload is required");
  }

  const activeSink = options.sink ?? sink;

  // Production path: no sink configured, org present => persist for the worker.
  if (!activeSink && options.maintainerOrgId) {
    const created = await prisma.sorobanOutbox.create({
      data: {
        maintainerOrgId: options.maintainerOrgId,
        action: options.action ?? "register",
        payload: payload as Prisma.InputJsonValue,
        status: "PENDING",
      },
    });
    return created as unknown as SorobanOutboxEntry;
  }

  // In-memory path (tests, local worker loop, or legacy callers).
  const now = new Date().toISOString();
  const id = options.idempotencyKey ?? randomUUID();

  const existing = outbox.get(id);
  if (existing && existing.status !== "FAILED") {
    return existing;
  }

  const entry: SorobanOutboxEntry = {
    id,
    payload,
    status: "PENDING",
    attempts: existing?.attempts ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  outbox.set(id, entry);

  if (activeSink) {
    try {
      // Pass the live entry: the sink observes it as-enqueued (PENDING) and
      // callers holding the reference see the terminal state assigned below.
      // (A snapshot copy would break identity between the delivered object
      // and the stored entry, which the in-memory contract tests pin.)
      await activeSink(entry);
      entry.status = "COMPLETED";
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
    } catch (error) {
      entry.status = "FAILED";
      entry.attempts += 1;
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.updatedAt = new Date().toISOString();
      outbox.set(id, entry);
      throw error;
    }
  }

  return entry;
}

export function getSorobanOutboxEntry(
  id: string,
): SorobanOutboxEntry | undefined {
  return outbox.get(id);
}

export function listSorobanOutbox(): SorobanOutboxEntry[] {
  return Array.from(outbox.values());
}

export function clearSorobanOutbox(): void {
  outbox.clear();
}
