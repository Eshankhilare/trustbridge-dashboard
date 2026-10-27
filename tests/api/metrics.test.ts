import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { GET } from "@/app/api/metrics/route";

/**
 * Tests for GET /api/metrics
 *
 * Authorization matrix:
 *   - Unauthenticated (requireOperator → null)          → 403, no payload
 *   - Viewer / non-operator (requireOperator → null)    → 403, no payload
 *   - Operator or higher (requireOperator → session)    → 200
 *
 * Functional coverage:
 *   - Contributor counts and readyPercent
 *   - Audit summary (recentEntries, byAction, latestAt)
 *   - Operational config from environment variables
 *   - sorobanContractConfigured flag
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mocks
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("@/lib/api-auth", () => ({
  requireOperator: vi.fn(),
}));

vi.mock("@/lib/registrations", () => ({
  getContributors: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  getRecentAuditLog: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    registration: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    addressHistoryRecord: {
      count: vi.fn().mockResolvedValue(0),
    },
  },
}));

import { requireOperator } from "@/lib/api-auth";
import { getContributors } from "@/lib/registrations";
import { getRecentAuditLog } from "@/lib/audit";
import type { ContributorRow } from "@/types";
import type { AuditLogEntry } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.clearAllMocks();
});

const operatorSession = {
  user: { id: "operator-1", isMaintainer: true, role: "operator", githubUsername: "op-user" },
  expires: "2099-01-01T00:00:00.000Z",
};

function makeContributor(
  id: string,
  readiness: ContributorRow["readiness"]
): ContributorRow {
  return {
    id,
    githubUsername: id,
    stellarAddress: `GADDR_${id}`,
    trustlineReady: readiness === "ready",
    trustlineAuthorized: readiness === "ready",
    verified: readiness === "ready",
    funded: readiness !== "not_ready",
    xlmBalance: "5",
    spendableXlmBalance: "3",
    lastCheckedAt: "2026-01-01T00:00:00Z",
    readiness,
  };
}

function makeAuditEntry(action: string): AuditLogEntry {
  return {
    id: `log_${action}`,
    actorId: "user_1",
    actorLogin: "octocat",
    action,
    targetId: null,
    targetLabel: null,
    metadata: null,
    createdAt: "2026-01-01T00:00:00Z",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Authorization
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/metrics — authorization", () => {
  it("returns 403 when unauthenticated (requireOperator returns null)", async () => {
    vi.mocked(requireOperator).mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Forbidden");
    expect(getContributors).not.toHaveBeenCalled();
  });

  it("returns 403 for a viewer (requireOperator returns null)", async () => {
    // requireOperator returns null for roles below operator — viewer included
    vi.mocked(requireOperator).mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(403);
    expect(getContributors).not.toHaveBeenCalled();
  });

  it("allows an operator to read metrics", async () => {
    vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    vi.mocked(getContributors).mockResolvedValue({ contributors: [], total: 0 });
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
    expect(requireOperator).toHaveBeenCalledWith("metrics.read");
  });

  it("allows an admin to read metrics (admin satisfies operator minimum)", async () => {
    const adminSession = {
      ...operatorSession,
      user: { ...operatorSession.user, role: "admin" },
    };
    vi.mocked(requireOperator).mockResolvedValue(adminSession as never);
    vi.mocked(getContributors).mockResolvedValue({ contributors: [], total: 0 });
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);

    const res = await GET();

    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Contributor counts
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/metrics — contributor counts", () => {
  beforeEach(() => {
    vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
  });

  it("returns correct total, ready count, readyPercent and byStatus breakdown", async () => {
    vi.mocked(getContributors).mockResolvedValue({
      contributors: [
        makeContributor("a", "ready"),
        makeContributor("b", "ready"),
        makeContributor("c", "low_reserve"),
        makeContributor("d", "not_ready"),
      ],
      total: 4,
    });
    vi.mocked(getRecentAuditLog).mockResolvedValue([
      makeAuditEntry("recheck.single"),
      makeAuditEntry("recheck.single"),
      makeAuditEntry("recheck.batch"),
    ]);

    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.contributors.total).toBe(4);
    expect(json.contributors.ready).toBe(2);
    expect(json.contributors.readyPercent).toBe(50);
    expect(json.contributors.byStatus.ready).toBe(2);
    expect(json.contributors.byStatus.low_reserve).toBe(1);
    expect(json.contributors.byStatus.not_ready).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Audit summary
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/metrics — audit summary", () => {
  beforeEach(() => {
    vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    vi.mocked(getContributors).mockResolvedValue({ contributors: [], total: 0 });
  });

  it("returns audit summary grouped by action", async () => {
    vi.mocked(getRecentAuditLog).mockResolvedValue([
      makeAuditEntry("recheck.single"),
      makeAuditEntry("recheck.single"),
      makeAuditEntry("recheck.batch"),
    ]);

    const res = await GET();
    const json = await res.json();

    expect(json.audit.recentEntries).toBe(3);
    expect(json.audit.byAction["recheck.single"]).toBe(2);
    expect(json.audit.byAction["recheck.batch"]).toBe(1);
    expect(json.audit.latestAt).toBe("2026-01-01T00:00:00Z");
  });

  it("returns null latestAt when there are no audit entries", async () => {
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);

    const res = await GET();
    const json = await res.json();

    expect(json.audit.latestAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Operational config
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/metrics — operational config", () => {
  beforeEach(() => {
    vi.mocked(requireOperator).mockResolvedValue(operatorSession as never);
    vi.mocked(getContributors).mockResolvedValue({ contributors: [], total: 0 });
    vi.mocked(getRecentAuditLog).mockResolvedValue([]);
  });

  it("includes operational config from environment variables", async () => {
    process.env.RATE_LIMIT_MAX_REQUESTS = "20";
    process.env.HORIZON_CB_FAILURE_THRESHOLD = "3";
    process.env.SOROBAN_CONTRACT_ID = "CTEST123";

    const res = await GET();
    const json = await res.json();

    expect(json.config.rateLimitMaxRequests).toBe(20);
    expect(json.config.circuitBreakerFailureThreshold).toBe(3);
    expect(json.config.sorobanContractConfigured).toBe(true);
  });

  it("reports sorobanContractConfigured as false when SOROBAN_CONTRACT_ID is unset", async () => {
    delete process.env.SOROBAN_CONTRACT_ID;

    const res = await GET();
    const json = await res.json();

    expect(json.config.sorobanContractConfigured).toBe(false);
  });
});
