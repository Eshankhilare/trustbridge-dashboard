import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    sorobanOutbox: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/soroban-register", () => ({
  mirrorRegistrationToSoroban: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

import { prisma } from "@/lib/prisma";
import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { recordAuditLog } from "@/lib/audit";
import {
  listSorobanOutboxDeadLetters,
  processSorobanOutbox,
  replayFailedSorobanOutboxEntry,
} from "./soroban-outbox-worker";
import {
  enqueueSorobanOutbox,
  setSorobanOutboxSink,
  clearSorobanOutbox,
  getSorobanOutboxEntry,
  listSorobanOutbox,
} from "./soroban-outbox";

describe("Soroban Outbox Worker (Issue #199)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.sorobanOutbox.updateMany).mockResolvedValue({ count: 1 });
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  afterEach(() => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
  });

  it("processes pending outbox records and marks them completed on success", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-1",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user1", registrationId: "reg-1" },
        status: "PENDING",
        attempts: 0,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: true,
      txHash: "0xhash",
      errors: [],
    });

    const result = await processSorobanOutbox();

    expect(result.processedCount).toBe(1);
    expect(result.successCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-1" },
      data: expect.objectContaining({ status: "COMPLETED" }),
    });
  });

  it("updates attempts with exponential backoff on failure and marks FAILED when max attempts exceeded", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-2",
        maintainerOrgId: "default",
        action: "register",
        payload: { stellarAddress: "G123", githubUsername: "user2", registrationId: "reg-2" },
        status: "PENDING",
        attempts: 4,
        maxAttempts: 5,
        lastError: null,
        nextAttemptAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    vi.mocked(mirrorRegistrationToSoroban).mockResolvedValueOnce({
      success: false,
      errors: ["RPC Timeout"],
    });

    const result = await processSorobanOutbox({ maxAttempts: 5 });

    expect(result.failedCount).toBe(1);
    expect(prisma.sorobanOutbox.update).toHaveBeenCalledWith({
      where: { id: "outbox-2" },
      data: expect.objectContaining({ status: "FAILED", attempts: 5 }),
    });

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "soroban_outbox_exhausted",
        targetId: "outbox-2",
      })
    );
  });

  it("lists only failed outbox metadata for the requested maintainer org", async () => {
    vi.mocked(prisma.sorobanOutbox.findMany).mockResolvedValueOnce([
      {
        id: "outbox-failed-1",
        action: "register",
        attempts: 5,
        lastError: "RPC timeout",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as any);

    const items = await listSorobanOutboxDeadLetters("org-1", 20);

    expect(prisma.sorobanOutbox.findMany).toHaveBeenCalledWith({
      where: { maintainerOrgId: "org-1", status: "FAILED" },
      select: {
        id: true,
        action: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: "desc" },
      take: 20,
    });
    expect(items[0]).not.toHaveProperty("payload");
  });

  it("atomically resets a failed item for replay within the requested org", async () => {
    vi.mocked(prisma.sorobanOutbox.findFirst).mockResolvedValueOnce({
      id: "outbox-failed-1",
      action: "register",
      attempts: 5,
    } as any);

    const item = await replayFailedSorobanOutboxEntry(
      "outbox-failed-1",
      "org-1"
    );

    expect(item).toEqual({
      id: "outbox-failed-1",
      action: "register",
      previousAttempts: 5,
    });
    expect(prisma.sorobanOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "outbox-failed-1",
        maintainerOrgId: "org-1",
        status: "FAILED",
      },
      data: expect.objectContaining({
        status: "PENDING",
        attempts: 0,
        lastError: null,
      }),
    });
  });

  it("does not replay items that are missing, non-failed, or outside the org", async () => {
    vi.mocked(prisma.sorobanOutbox.findFirst).mockResolvedValueOnce(null);

    await expect(
      replayFailedSorobanOutboxEntry("outbox-other-org", "org-1")
    ).resolves.toBeNull();
    expect(prisma.sorobanOutbox.updateMany).not.toHaveBeenCalled();
  });
});

describe("Unified Outbox Adapter (Issue #488)", () => {
  it("routes production enqueue through Prisma create", async () => {
    vi.mocked(prisma.sorobanOutbox.create).mockResolvedValueOnce({
      id: "outbox-test-1",
      maintainerOrgId: "org-1",
      action: "register",
      payload: { stellarAddress: "G1", githubUsername: "u1", registrationId: "r1" },
      status: "PENDING",
      attempts: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);

    const result = await enqueueSorobanOutbox(
      {
        stellarAddress: "G1",
        githubUsername: "u1",
        registrationId: "r1",
      },
      {
        maintainerOrgId: "org-1",
        action: "register",
      }
    );

    expect(prisma.sorobanOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        maintainerOrgId: "org-1",
        action: "register",
        status: "PENDING",
      }),
    });
    expect(result.id).toBe("outbox-test-1");
  });

  it("runs in-memory via test sink when setSorobanOutboxSink is configured", async () => {
    // Capture the observed status eagerly: the sink receives the live entry
    // object, which the adapter marks COMPLETED after delivery resolves.
    const observedStatuses: unknown[] = [];
    const sinkMock = vi.fn(async (entry: { status: unknown }) => {
      observedStatuses.push(entry.status);
    });
    setSorobanOutboxSink(sinkMock);

    const payload = { stellarAddress: "G2", githubUsername: "u2", registrationId: "r2" };
    const entry = await enqueueSorobanOutbox(payload, { idempotencyKey: "idem-1" });

    expect(sinkMock).toHaveBeenCalledTimes(1);
    // The sink observed the entry as-enqueued (PENDING)...
    expect(observedStatuses).toEqual(["PENDING"]);
    // ...while the stored entry advanced to COMPLETED after delivery.
    expect(entry.status).toBe("COMPLETED");
    expect(getSorobanOutboxEntry("idem-1")?.status).toBe("COMPLETED");
  });

  it("marks rows failed and increments attempts when sink callback throws", async () => {
    const sinkError = new Error("Sink delivery failure");
    setSorobanOutboxSink(vi.fn().mockRejectedValue(sinkError));

    await expect(
      enqueueSorobanOutbox({ test: 123 }, { idempotencyKey: "fail-1" })
    ).rejects.toThrow("Sink delivery failure");

    const entry = getSorobanOutboxEntry("fail-1");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("FAILED");
    expect(entry?.attempts).toBe(1);
    expect(entry?.lastError).toBe("Sink delivery failure");
  });

  it("clears in-memory outbox state without leaving stale Map entries across tests", () => {
    setSorobanOutboxSink(null);
    clearSorobanOutbox();
    expect(listSorobanOutbox()).toHaveLength(0);
  });
});

