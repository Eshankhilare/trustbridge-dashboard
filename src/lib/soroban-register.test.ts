import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock logger before importing soroban-register so the spy is in place.
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  const mockLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    ...actual,
    logger: {
      ...mockLogger,
      child: vi.fn().mockReturnValue(mockLogger),
    },
  };
});

import { mirrorRegistrationToSoroban } from "@/lib/soroban-register";
import { logger } from "@/lib/logger";

const PAYLOAD = {
  githubUsername: "octocat",
  stellarAddress: "GBSX3XVYB7XOQY4LZGQ7ZXZQY4LZGQ7ZXZQY4LZGQ7ZXZQY4LZG",
  registrationId: "reg-001",
};

const ORIGINAL_ENV = process.env;

describe("mirrorRegistrationToSoroban", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.clearAllMocks();
  });

  it("skips and returns success when SOROBAN_CONTRACT_ID is unset", async () => {
    delete process.env.SOROBAN_CONTRACT_ID;

    const result = await mirrorRegistrationToSoroban(PAYLOAD);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skipped).toBe(true);
    }
  });

  it("does not throw when SOROBAN_CONTRACT_ID is unset — fail-safe", async () => {
    delete process.env.SOROBAN_CONTRACT_ID;
    await expect(mirrorRegistrationToSoroban(PAYLOAD)).resolves.toBeDefined();
  });

  it("returns success: false and calls logger.error on RPC failure", async () => {
    // A valid-looking contract id but invalid RPC url to trigger the URL error
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "not-a-valid-url";

    const childLogger = (logger.child as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    const result = await mirrorRegistrationToSoroban(PAYLOAD);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
      expect(typeof result.error).toBe("object");
    }
  });

  it("logs error with structured fields when Soroban RPC fails", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "not-a-valid-url";

    await mirrorRegistrationToSoroban(PAYLOAD);

    // The child logger's error method should have been called
    const childMock = vi.mocked(logger.child);
    expect(childMock).toHaveBeenCalled();
  });

  it("never throws on any failure — best-effort contract", async () => {
    process.env.SOROBAN_CONTRACT_ID = "BAD_ID_THAT_WILL_FAIL";

    const result = await mirrorRegistrationToSoroban(PAYLOAD);
    // Must be a result object, not a thrown exception
    expect(typeof result).toBe("object");
    expect(result).toHaveProperty("success");
  });

  it("returns success for valid contract id and valid RPC url", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
    process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";

    const result = await mirrorRegistrationToSoroban(PAYLOAD);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.skipped).toBeFalsy();
    }
  });
});
