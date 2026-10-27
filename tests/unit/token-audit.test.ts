import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Provide a factory mock so prisma.tokenAuditLog.create is a real vi.fn().
// Auto-mock (vi.mock("@/lib/prisma")) doesn't work for PrismaClient because
// the nested methods aren't enumerable at mock-time.
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tokenAuditLog: {
      create: vi.fn(),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { recordTokenAudit } from "@/lib/token-audit";

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/** Parse the first JSON line written to stderr. */
function parseErrorLog(spy: ReturnType<typeof vi.spyOn>) {
  expect(spy).toHaveBeenCalled();
  const raw = spy.mock.calls[0][0] as string;
  return JSON.parse(raw) as Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────
// recordTokenAudit — happy path
// ────────────────────────────────────────────────────────────────────────────

describe("recordTokenAudit — happy path", () => {
  beforeEach(() => {
    vi.mocked(prisma.tokenAuditLog.create).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("writes the audit record to the database", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    expect(prisma.tokenAuditLog.create).toHaveBeenCalledOnce();
    expect(prisma.tokenAuditLog.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        action: "token_encrypted_at_signin",
        success: true,
        detail: undefined,
      },
    });
  });

  it("forwards the optional detail field", async () => {
    await recordTokenAudit("user-2", "token_decrypted", true, "some detail");
    expect(prisma.tokenAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ detail: "some detail" }),
    });
  });

  it("never throws even when prisma succeeds", async () => {
    await expect(
      recordTokenAudit("user-3", "token_decrypt_failed", false)
    ).resolves.toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// recordTokenAudit — DB write failure → StructuredLogger
// ────────────────────────────────────────────────────────────────────────────

describe("recordTokenAudit — DB write failure", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.mocked(prisma.tokenAuditLog.create).mockRejectedValue(
      new Error("DB connection lost")
    );
  });

  afterEach(() => {
    errorSpy.mockRestore();
    vi.clearAllMocks();
  });

  it("never throws when the DB write fails", async () => {
    await expect(
      recordTokenAudit("user-1", "token_encrypted_at_signin", true)
    ).resolves.toBeUndefined();
  });

  it("emits a structured log via stderr (not a bare two-arg console.error call)", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    // Must be a single JSON-encoded structured log.
    expect(errorSpy).toHaveBeenCalledOnce();
    const arg = errorSpy.mock.calls[0][0];
    // The argument must be a valid JSON string, not a plain-text message.
    expect(() => JSON.parse(arg as string)).not.toThrow();
    // Old code passed two args (message, error); new code passes one JSON string.
    expect(errorSpy.mock.calls[0]).toHaveLength(1);
  });

  it("uses the stable event name 'token_audit_write_failed' as the message", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    expect(log.message).toBe("token_audit_write_failed");
  });

  it("sets level to 'error'", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    expect(log.level).toBe("error");
  });

  it("sets context to 'token-audit'", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    expect(log.context).toBe("token-audit");
  });

  it("includes a timestamp", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    expect(typeof log.timestamp).toBe("string");
    expect(log.timestamp).toBeTruthy();
  });

  it("includes userId in details", async () => {
    await recordTokenAudit("user-42", "token_decrypted", true);
    const log = parseErrorLog(errorSpy);
    expect(log.userId).toBe("user-42");
  });

  it("includes action in details", async () => {
    await recordTokenAudit("user-1", "token_decrypt_failed", false);
    const log = parseErrorLog(errorSpy);
    expect(log.action).toBe(
      "token_decrypt_failed"
    );
  });

  it("includes success flag in details", async () => {
    await recordTokenAudit("user-1", "token_encryption_skipped", false);
    const log = parseErrorLog(errorSpy);
    expect(log.success).toBe(false);
  });

  it("includes errorMessage as a string in details", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    // The flat structured-log shape merges metadata at the top level.
    const details = log as Record<string, unknown>;
    expect(typeof details.errorMessage).toBe("string");
    expect(details.errorMessage).toBe("DB connection lost");
  });

  it("coerces non-Error throws to a string errorMessage", async () => {
    vi.mocked(prisma.tokenAuditLog.create).mockRejectedValue("string error");
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    // The flat structured-log shape merges metadata at the top level.
    const details = log as Record<string, unknown>;
    expect(typeof details.errorMessage).toBe("string");
    expect(details.errorMessage).toBe("string error");
  });

  it("does NOT include the raw error object in details", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    // The flat structured-log shape merges metadata at the top level.
    const details = log as Record<string, unknown>;
    // A raw Error serialises to {} — any such key is a red flag.
    expect(details).not.toHaveProperty("error");
    expect(details).not.toHaveProperty("err");
  });

  it("does NOT include the detail argument (which could hold sensitive context) in log payload", async () => {
    // 'detail' is an arbitrary caller-supplied string that must NOT be forwarded
    // to the failure log — it could contain token excerpts or sensitive IDs.
    await recordTokenAudit(
      "user-1",
      "token_encrypted_at_signin",
      true,
      "secret-context"
    );
    const log = parseErrorLog(errorSpy);
    const serialised = JSON.stringify(log);
    expect(serialised).not.toContain("secret-context");
  });

  it("does NOT log any token-like field names in the payload", async () => {
    await recordTokenAudit("user-1", "token_encrypted_at_signin", true);
    const log = parseErrorLog(errorSpy);
    const serialised = JSON.stringify(log).toLowerCase();
    expect(serialised).not.toMatch(/"token":/);
    expect(serialised).not.toMatch(/"accesstoken":/);
    expect(serialised).not.toMatch(/"secret":/);
  });

  it("handles all four TokenAuditAction values without throwing", async () => {
    const actions = [
      "token_encrypted_at_signin",
      "token_encryption_skipped",
      "token_decrypted",
      "token_decrypt_failed",
    ] as const;

    for (const action of actions) {
      await expect(
        recordTokenAudit("user-x", action, false)
      ).resolves.toBeUndefined();
    }
    // One structured log per action.
    expect(errorSpy).toHaveBeenCalledTimes(actions.length);
  });
});
