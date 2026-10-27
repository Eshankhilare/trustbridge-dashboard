/**
 * Unit tests for BackgroundQueue — focused on DLQ promotion, health metrics,
 * and concurrent-read safety of getWorkerHealthMetrics.
 */

import { afterEach, describe, expect, it } from "vitest";
import { InMemoryBackgroundQueue } from "@/lib/background-queue";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Succeed on the first call; fail on every call thereafter. */
function succeedOnce(): (payload: unknown) => Promise<void> {
  let called = false;
  return async () => {
    if (called) throw new Error("intentional failure");
    called = true;
  };
}

/** Always fail. */
function alwaysFail(msg = "handler error"): (payload: unknown) => Promise<void> {
  return async () => {
    throw new Error(msg);
  };
}

/** Always succeed. */
function alwaysSucceed(): (payload: unknown) => Promise<void> {
  return async () => {
    /* no-op */
  };
}

// ---------------------------------------------------------------------------
// Basic lifecycle
// ---------------------------------------------------------------------------

describe("BackgroundQueue – basic lifecycle", () => {
  it("starts with empty metrics and zero counts", () => {
    const q = new InMemoryBackgroundQueue();
    const m = q.getWorkerHealthMetrics();

    expect(m.pendingCount).toBe(0);
    expect(m.processingCount).toBe(0);
    expect(m.completedCount).toBe(0);
    expect(m.dlqCount).toBe(0);
    expect(m.totalEnqueued).toBe(0);
    expect(m.lastProcessedAt).toBeNull();
    expect(m.workerStartedAt).toBeNull();
  });

  it("increments pendingCount when a job is enqueued", () => {
    const q = new InMemoryBackgroundQueue();
    q.enqueue({ target: "G123" });

    expect(q.getWorkerHealthMetrics().pendingCount).toBe(1);
    expect(q.getWorkerHealthMetrics().totalEnqueued).toBe(1);
  });

  it("sets workerStartedAt on first enqueue", () => {
    const q = new InMemoryBackgroundQueue();
    expect(q.getWorkerHealthMetrics().workerStartedAt).toBeNull();

    q.enqueue("job");
    const m = q.getWorkerHealthMetrics();
    expect(m.workerStartedAt).not.toBeNull();
    expect(new Date(m.workerStartedAt!).getTime()).not.toBeNaN();
  });

  it("does not change workerStartedAt on subsequent enqueues", async () => {
    const q = new InMemoryBackgroundQueue();
    q.enqueue("a");
    const first = q.getWorkerHealthMetrics().workerStartedAt;

    // Small delay to ensure timestamps would differ if the guard is broken
    await new Promise((r) => setTimeout(r, 5));
    q.enqueue("b");

    expect(q.getWorkerHealthMetrics().workerStartedAt).toBe(first);
  });

  it("moves job to completed and updates lastProcessedAt", async () => {
    const q = new InMemoryBackgroundQueue();
    q.enqueue("data");
    await q.process(alwaysSucceed());

    const m = q.getWorkerHealthMetrics();
    expect(m.pendingCount).toBe(0);
    expect(m.completedCount).toBe(1);
    expect(m.lastProcessedAt).not.toBeNull();
    expect(new Date(m.lastProcessedAt!).getTime()).not.toBeNaN();
  });

  it("returns null from process() when queue is empty", async () => {
    const q = new InMemoryBackgroundQueue();
    const result = await q.process(alwaysSucceed());
    expect(result).toBeNull();
  });

  it("returns job id from process() when a job runs", async () => {
    const q = new InMemoryBackgroundQueue();
    const id = q.enqueue("payload");
    const processed = await q.process(alwaysSucceed());
    expect(processed).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// DLQ promotion
// ---------------------------------------------------------------------------

describe("BackgroundQueue – DLQ promotion", () => {
  it("retries up to maxAttempts before moving to DLQ", async () => {
    const q = new InMemoryBackgroundQueue(3);
    q.enqueue("will-fail");
    const fail = alwaysFail();

    // Attempts 1 and 2: status returns to pending for retry
    await q.process(fail);
    expect(q.getWorkerHealthMetrics().pendingCount).toBe(1);
    expect(q.getWorkerHealthMetrics().dlqCount).toBe(0);

    await q.process(fail);
    expect(q.getWorkerHealthMetrics().pendingCount).toBe(1);
    expect(q.getWorkerHealthMetrics().dlqCount).toBe(0);

    // Attempt 3: exhausted — promoted to DLQ
    await q.process(fail);
    const m = q.getWorkerHealthMetrics();
    expect(m.pendingCount).toBe(0);
    expect(m.dlqCount).toBe(1);
    expect(m.completedCount).toBe(0);
  });

  it("increments dlqCount for each DLQ job independently", async () => {
    const q = new InMemoryBackgroundQueue(1);
    q.enqueue("a");
    q.enqueue("b");
    await q.process(alwaysFail());
    await q.process(alwaysFail());
    expect(q.getWorkerHealthMetrics().dlqCount).toBe(2);
  });

  it("does not update lastProcessedAt when a job fails into DLQ", async () => {
    const q = new InMemoryBackgroundQueue(1);
    q.enqueue("fail-job");
    await q.process(alwaysFail());
    // DLQ promotion should not record a successful lastProcessedAt
    expect(q.getWorkerHealthMetrics().lastProcessedAt).toBeNull();
  });

  it("keeps completed count separate from DLQ count in mixed scenario", async () => {
    const q = new InMemoryBackgroundQueue(1);
    q.enqueue("good");
    q.enqueue("bad");

    await q.process(alwaysSucceed()); // good → completed
    await q.process(alwaysFail());   // bad → dlq

    const m = q.getWorkerHealthMetrics();
    expect(m.completedCount).toBe(1);
    expect(m.dlqCount).toBe(1);
    expect(m.pendingCount).toBe(0);
    expect(m.totalEnqueued).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Metrics reset and isolation
// ---------------------------------------------------------------------------

describe("BackgroundQueue – metrics reset", () => {
  it("clear() resets all counters to zero", async () => {
    const q = new InMemoryBackgroundQueue();
    q.enqueue("x");
    await q.process(alwaysSucceed());
    q.clear();

    const m = q.getWorkerHealthMetrics();
    expect(m.pendingCount).toBe(0);
    expect(m.completedCount).toBe(0);
    expect(m.totalEnqueued).toBe(0);
    expect(m.lastProcessedAt).toBeNull();
    expect(m.workerStartedAt).toBeNull();
  });

  it("independent instances do not share state", async () => {
    const a = new InMemoryBackgroundQueue();
    const b = new InMemoryBackgroundQueue();
    a.enqueue("for-a");
    await a.process(alwaysSucceed());

    expect(a.getWorkerHealthMetrics().completedCount).toBe(1);
    expect(b.getWorkerHealthMetrics().completedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Read-only safety of getWorkerHealthMetrics
// ---------------------------------------------------------------------------

describe("BackgroundQueue – getWorkerHealthMetrics read-only safety", () => {
  it("multiple consecutive calls return stable counts", async () => {
    const q = new InMemoryBackgroundQueue();
    q.enqueue("a");
    q.enqueue("b");
    await q.process(alwaysSucceed());

    const m1 = q.getWorkerHealthMetrics();
    const m2 = q.getWorkerHealthMetrics();
    expect(m1).toEqual(m2);
  });

  it("returns zeros for all fields (not undefined) on empty queue", () => {
    const q = new InMemoryBackgroundQueue();
    const m = q.getWorkerHealthMetrics();
    // All numeric fields must be 0, not undefined/null
    expect(m.pendingCount).toBe(0);
    expect(m.processingCount).toBe(0);
    expect(m.completedCount).toBe(0);
    expect(m.dlqCount).toBe(0);
    expect(m.totalEnqueued).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Durable queue DLQ additions (issue #200)
// ---------------------------------------------------------------------------
/**
 * Unit tests for the dead-letter-queue additions to BackgroundQueue (issue #200):
 * error size cap + PII redaction, getFailedJobs, retryJob.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    queueJob: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      count: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import {
  MAX_ERROR_LENGTH,
  backgroundQueue,
  sanitizeJobError,
} from "@/lib/background-queue";

const findMany = vi.mocked(prisma.queueJob.findMany);
const findUnique = vi.mocked(prisma.queueJob.findUnique);
const update = vi.mocked(prisma.queueJob.update);

const SAMPLE_ADDRESS = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("sanitizeJobError", () => {
  describe("truncation limits", () => {
    it("caps oversized messages to MAX_ERROR_LENGTH plus truncation suffix", () => {
      const longMessage = "x".repeat(MAX_ERROR_LENGTH + 5000);
      const out = sanitizeJobError(longMessage);
      expect(out.startsWith("x".repeat(MAX_ERROR_LENGTH))).toBe(true);
      expect(out.endsWith("…[truncated]")).toBe(true);
      expect(out.length).toBe(MAX_ERROR_LENGTH + "…[truncated]".length);
    });

    it("does not truncate a message that is exactly MAX_ERROR_LENGTH characters", () => {
      const exactMessage = "a".repeat(MAX_ERROR_LENGTH);
      const out = sanitizeJobError(exactMessage);
      expect(out).toBe(exactMessage);
      expect(out.length).toBe(MAX_ERROR_LENGTH);
      expect(out).not.toContain("…[truncated]");
    });

    it("truncates a message that is MAX_ERROR_LENGTH + 1 characters", () => {
      const slightlyLongMessage = "b".repeat(MAX_ERROR_LENGTH + 1);
      const out = sanitizeJobError(slightlyLongMessage);
      expect(out.startsWith("b".repeat(MAX_ERROR_LENGTH))).toBe(true);
      expect(out.endsWith("…[truncated]")).toBe(true);
      expect(out.length).toBe(MAX_ERROR_LENGTH + "…[truncated]".length);
    });

    it("leaves a short benign message untouched", () => {
      const msg = "Horizon connection timeout after 15000ms";
      expect(sanitizeJobError(msg)).toBe(msg);
    });

    it("redacts secrets before applying the truncation length cap", () => {
      const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
      const longMessageWithSecret = `Failed with token ${secret}: ${"z".repeat(MAX_ERROR_LENGTH + 100)}`;
      const out = sanitizeJobError(longMessageWithSecret);
      expect(out).not.toContain(secret);
      expect(out).toContain("[redacted:github-token]");
      expect(out.endsWith("…[truncated]")).toBe(true);
    });
  });

  describe("known secret pattern redaction", () => {
    it("redacts a Stellar public G-address", () => {
      const out = sanitizeJobError(`account ${SAMPLE_ADDRESS} not found`);
      expect(out).not.toContain(SAMPLE_ADDRESS);
      expect(out).toContain("[redacted:stellar-address]");
    });

    it("redacts a Stellar secret S-seed distinctly from public address", () => {
      const secretSeed = "SCZANGBA5YHTNYVVV4C3U252E2B6P6F5PSSFTGNJDQTFJDAXLHIRP4A6";
      const out = sanitizeJobError(`error signing with seed ${secretSeed}`);
      expect(out).not.toContain(secretSeed);
      expect(out).toContain("[redacted:stellar-secret]");
    });

    it.each([
      ["ghp_", "ghp_1234567890abcdefghijklmnopqrstuvwxyz"],
      ["gho_", "gho_1234567890abcdefghijklmnopqrstuvwxyz"],
      ["ghs_", "ghs_1234567890abcdefghijklmnopqrstuvwxyz"],
      ["ghu_", "ghu_1234567890abcdefghijklmnopqrstuvwxyz"],
      ["ghr_", "ghr_1234567890abcdefghijklmnopqrstuvwxyz"],
      ["github_pat_", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345"],
    ])("redacts GitHub token of type %s", (_prefix, token) => {
      const out = sanitizeJobError(`Unauthorized request with token ${token}`);
      expect(out).not.toContain(token);
      expect(out).toContain("[redacted:github-token]");
    });

    it("redacts credentials in database connection strings", () => {
      const connStr = "postgresql://tb_user:super_secret_pw@db.internal:5432/trustbridge";
      const out = sanitizeJobError(`Connection failed: ${connStr}`);
      expect(out).not.toContain("super_secret_pw");
      expect(out).not.toContain("tb_user");
      expect(out).toContain("postgresql://[redacted:credentials]@db.internal:5432/trustbridge");
    });

    it("redacts Authorization bearer and token headers", () => {
      const outBearer = sanitizeJobError("Request header Authorization: Bearer secret_jwt_token_1234567890");
      expect(outBearer).not.toContain("secret_jwt_token_1234567890");
      expect(outBearer).toContain("Bearer [redacted:token]");

      const outToken = sanitizeJobError("Request header Authorization: Token secret_api_key_1234567890");
      expect(outToken).not.toContain("secret_api_key_1234567890");
      expect(outToken).toContain("Token [redacted:token]");
    });

    it("redacts email addresses", () => {
      const out = sanitizeJobError("Failed notifying user alice.contributor@example.com");
      expect(out).not.toContain("alice.contributor@example.com");
      expect(out).toContain("[redacted:email]");
    });

    it("redacts multiple mixed secrets in a single message", () => {
      const token = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
      const email = "maintainer@trustbridge.org";
      const out = sanitizeJobError(`User ${email} with ${SAMPLE_ADDRESS} and token ${token} failed`);
      expect(out).not.toContain(token);
      expect(out).not.toContain(email);
      expect(out).not.toContain(SAMPLE_ADDRESS);
      expect(out).toContain("[redacted:github-token]");
      expect(out).toContain("[redacted:email]");
      expect(out).toContain("[redacted:stellar-address]");
    });
  });

  describe("empty and null inputs fallback", () => {
    it("returns 'Unknown error' when input is null", () => {
      expect(sanitizeJobError(null)).toBe("Unknown error");
    });

    it("returns 'Unknown error' when input is undefined", () => {
      expect(sanitizeJobError(undefined)).toBe("Unknown error");
      expect(sanitizeJobError()).toBe("Unknown error");
    });

    it("returns 'Unknown error' when input is empty string", () => {
      expect(sanitizeJobError("")).toBe("Unknown error");
    });

    it("returns 'Unknown error' when input is whitespace only", () => {
      expect(sanitizeJobError("   ")).toBe("Unknown error");
      expect(sanitizeJobError("\t\n\r")).toBe("Unknown error");
    });

    it("returns 'Unknown error' when non-string value is passed", () => {
      expect(sanitizeJobError(123 as unknown as string)).toBe("Unknown error");
      expect(sanitizeJobError({} as unknown as string)).toBe("Unknown error");
      expect(sanitizeJobError([] as unknown as string)).toBe("Unknown error");
    });
  });
});

describe("getFailedJobs", () => {
  it("queries only failed jobs, newest first, capped at 200", async () => {
    findMany.mockResolvedValue([] as never);
    await backgroundQueue.getFailedJobs({ limit: 9999 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "failed" },
        orderBy: { completedAt: "desc" },
        take: 200,
      }),
    );
  });

  it("scopes to the owner plus ownerless jobs", async () => {
    findMany.mockResolvedValue([] as never);
    await backgroundQueue.getFailedJobs({ ownerId: "user-1" });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "failed",
          OR: [{ ownerId: "user-1" }, { ownerId: null }],
        },
      }),
    );
  });

  it("maps rows into the Job shape", async () => {
    findMany.mockResolvedValue([
      {
        id: "j1",
        type: "recheck.single",
        status: "failed",
        data: { __retries: 1 },
        result: null,
        error: "boom",
        ownerId: "user-1",
        createdAt: new Date(),
        startedAt: new Date(),
        completedAt: new Date(),
      },
    ] as never);

    const jobs = await backgroundQueue.getFailedJobs();
    expect(jobs[0]).toMatchObject({ id: "j1", status: "failed", error: "boom" });
  });
});

describe("retryJob", () => {
  it("returns null when the job does not exist", async () => {
    findUnique.mockResolvedValue(null);
    expect(await backgroundQueue.retryJob("nope")).toBeNull();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns null when the job is not in the failed state", async () => {
    findUnique.mockResolvedValue({ id: "j1", status: "completed" } as never);
    expect(await backgroundQueue.retryJob("j1")).toBeNull();
  });

  it("returns null when the job belongs to another owner", async () => {
    findUnique.mockResolvedValue({
      id: "j1",
      status: "failed",
      ownerId: "someone-else",
      data: {},
    } as never);
    expect(
      await backgroundQueue.retryJob("j1", { ownerId: "user-1" }),
    ).toBeNull();
  });

  it("resets a failed job to pending and bumps the retry count", async () => {
    findUnique.mockResolvedValue({
      id: "j1",
      type: "recheck.batch",
      status: "failed",
      ownerId: "user-1",
      data: { __retries: 2 },
      result: null,
      error: "boom",
      createdAt: new Date(),
      startedAt: new Date(),
      completedAt: new Date(),
    } as never);
    update.mockImplementation((async (args: { data: unknown }) => ({
      id: "j1",
      type: "recheck.batch",
      status: "pending",
      ownerId: "user-1",
      data: (args.data as { data: unknown }).data,
      result: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    })) as never);

    const job = await backgroundQueue.retryJob("j1", { ownerId: "user-1" });
    expect(job?.status).toBe("pending");

    const updateArg = update.mock.calls[0][0] as {
      data: { status: string; error: null; data: { __retries: number } };
    };
    expect(updateArg.data.status).toBe("pending");
    expect(updateArg.data.error).toBeNull();
    expect(updateArg.data.data.__retries).toBe(3);
  });
});
