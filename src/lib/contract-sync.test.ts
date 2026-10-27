import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockContractCall = vi.hoisted(() => vi.fn());
const mockScValToNative = vi.hoisted(() => vi.fn(() => []));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("stellar-sdk", () => ({
  Contract: vi.fn().mockImplementation(() => ({
    call: mockContractCall,
  })),
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: "mock-retval" },
      }),
    })),
    Api: {
      isSimulationError: vi.fn().mockReturnValue(false),
    },
  },
  Account: vi.fn().mockImplementation(() => ({})),
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnValue({
      setTimeout: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue({}),
      }),
    }),
  })),
  nativeToScVal: vi.fn((value: unknown) => value),
  scValToNative: mockScValToNative,
  Networks: { TESTNET: "Test SDF Network ; September 2015" },
  xdr: { ScVal: vi.fn() },
}));

import { recordAuditLog } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import {
  getContractSyncHealth,
  resetContractSyncState,
  syncContractToPostgres,
} from "@/lib/contract-sync";

// Helper: build a minimal Registration row shape returned by prisma.findMany
function makeExistingReg(
  stellarAddress: string,
  githubUsername: string | null = null,
  userId?: string
) {
  const resolvedUserId = userId ?? `user-${stellarAddress}`;
  return {
    id: `id-${stellarAddress}`,
    stellarAddress,
    userId: resolvedUserId,
    user: { githubUsername },
  };
}

describe("contract-sync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetContractSyncState();
    delete process.env.CONTRACT_SYNC_MIN_INTERVAL_MS;
    delete process.env.SOROBAN_CONTRACT_ID;
    mockContractCall.mockResolvedValue([]);
    mockScValToNative.mockReturnValue([]);
    vi.mocked(prisma.registration.findMany).mockResolvedValue([]);
    vi.mocked(prisma.registration.update).mockResolvedValue({} as never);
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.user.update).mockResolvedValue({} as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ------------------------------------------------------------------
  // Existing baseline tests
  // ------------------------------------------------------------------

  it("runs a sync, records an audit log, and updates health on success", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CABC123";

    const result = await syncContractToPostgres();

    expect(result.status).toBe("ok");
    expect(result.synced).toBe(0);
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "contract.sync" })
    );
    expect(getContractSyncHealth()).toEqual(result);
  });

  it("never throws when Postgres sync fails, and records the error", async () => {
    process.env.SOROBAN_CONTRACT_ID = "CABC123";
    vi.mocked(prisma.registration.findMany).mockRejectedValue(
      new Error("Horizon RPC outage")
    );

    const result = await syncContractToPostgres();

    expect(result.status).toBe("error");
    expect(result.errors).toContain("Horizon RPC outage");
    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contract.sync",
        metadata: { error: "Horizon RPC outage" },
      })
    );
    expect(getContractSyncHealth()?.status).toBe("error");
  });

  it("rate-limits back-to-back triggers instead of re-hitting Soroban", async () => {
    process.env.CONTRACT_SYNC_MIN_INTERVAL_MS = "60000";
    process.env.SOROBAN_CONTRACT_ID = "CABC123";

    const first = await syncContractToPostgres();
    const second = await syncContractToPostgres();

    expect(first.status).toBe("ok");
    expect(second.status).toBe("skipped");
    expect(mockContractCall).toHaveBeenCalledTimes(1);
    expect(prisma.registration.findMany).toHaveBeenCalledTimes(1);
  });

  // ------------------------------------------------------------------
  // Counter behavior: created vs updated vs unchanged
  // ------------------------------------------------------------------

  describe("created counter", () => {
    it("increments created for each contract address absent from Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract returns two addresses that are NOT in Postgres
      mockScValToNative.mockReturnValue([
        ["GNEW1ADDRESS", "alice"],
        ["GNEW2ADDRESS", "bob"],
      ]);

      // Postgres has no registrations
      vi.mocked(prisma.registration.findMany).mockResolvedValue([]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.created).toBe(2);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
      expect(result.synced).toBe(2);
    });

    it("does not increment created for addresses already in Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract returns one address that IS in Postgres (same username)
      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.created).toBe(0);
      expect(result.unchanged).toBe(1);
    });

    it("counts zero created when all contract addresses exist in Postgres", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GADDR1", "alice"],
        ["GADDR2", "bob"],
        ["GADDR3", "carol"],
      ]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GADDR1", "alice") as never,
        makeExistingReg("GADDR2", "bob") as never,
        makeExistingReg("GADDR3", "carol") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(3);
    });
  });

  describe("updated counter", () => {
    it("increments updated when the contract reports a changed GitHub username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      // Contract reports a different githubUsername for an existing address
      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(result.unchanged).toBe(0);
      // The linked User row (not the Registration row) carries the username.
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-GEXISTS1ADDRESS" },
          data: expect.objectContaining({ githubUsername: "alice-new" }),
        })
      );
    });

    it("does not increment updated when the username is unchanged", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice") as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(prisma.registration.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Username-mismatch path: linked User.githubUsername is updated safely
  // ------------------------------------------------------------------

  describe("username mismatch", () => {
    it("updates the linked User.githubUsername when it diverges from the contract", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      // No other user already owns the new username
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await syncContractToPostgres();

      expect(result.updated).toBe(1);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-GEXISTS1ADDRESS" },
          data: expect.objectContaining({ githubUsername: "alice-new" }),
        })
      );
    });

    it("does not clobber a User that already owns the new username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice-new"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", "alice-old") as never,
      ]);

      // Another user already owns the new username
      vi.mocked(prisma.user.findFirst).mockResolvedValue({
        id: "other-user",
        githubUsername: "alice-new",
      } as never);

      const result = await syncContractToPostgres();

      // Conflict: counted as unchanged, and the other owner's row is untouched.
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------
  // Registration parsing edge cases
  // ------------------------------------------------------------------

  describe("registration parsing edge cases", () => {
    it("ignores a null contract payload without throwing", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue(null);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
      expect(result.created).toBe(0);
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(0);
    });

    it("ignores an undefined contract payload without throwing", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue(undefined);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("ignores an empty contract payload", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue([]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("skips malformed entries that are not address/username pairs", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        null,
        undefined,
        "GONLYADDRESS",
        [],
        ["GADDR1"],
        ["GADDR2", "alice", "extra"],
        ["GADDR3", "bob"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      // Only the well-formed pair should be counted
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("skips entries with a missing or non-string address", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        [null, "alice"],
        [undefined, "bob"],
        [123, "carol"],
        ["", "dave"],
        ["GADDR1", "erin"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("skips entries with a missing or non-string username", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GADDR1", null],
        ["GADDR2", undefined],
        ["GADDR3", 42],
        ["GADDR4", ""],
        ["GADDR5", "frank"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(1);
      expect(result.created).toBe(1);
    });

    it("treats a null username on an existing registration as unchanged", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([["GEXISTS1ADDRESS", "alice"]]);

      vi.mocked(prisma.registration.findMany).mockResolvedValue([
        makeExistingReg("GEXISTS1ADDRESS", null) as never,
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.updated).toBe(0);
      expect(result.unchanged).toBe(1);
    });

    it("handles duplicate addresses in the contract payload deterministically", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";

      mockScValToNative.mockReturnValue([
        ["GDUPADDRESS", "alice"],
        ["GDUPADDRESS", "alice"],
      ]);

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
    });

    it("does not throw when the contract payload is a non-iterable object", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      mockScValToNative.mockReturnValue({ unexpected: true });

      const result = await syncContractToPostgres();

      expect(result.status).toBe("ok");
      expect(result.synced).toBe(0);
    });

    it("records an error when the contract call itself rejects", async () => {
      process.env.SOROBAN_CONTRACT_ID = "CABC123";
      // The read path builds a simulation transaction synchronously, so a
      // failing contract call surfaces as a synchronous throw (not a
      // rejected promise) inside `simulateContractRead`.
      mockContractCall.mockImplementation(() => {
        throw new Error("RPC unavailable");
      });

      const result = await syncContractToPostgres();

      expect(result.status).toBe("error");
      expect(result.errors).toContain("RPC unavailable");
    });
  });
});
