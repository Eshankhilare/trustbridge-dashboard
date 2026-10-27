import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Tests for /api/contributors/export/csv and /api/contributors/export/json
 *
 * These routes are maintainer-only and handle sensitive treasury payouts.
 * Tests verify:
 * - Authorization (401 unauthenticated, 403 non-maintainer)
 * - Shape and snapshot stability
 * - Error handling
 * - Audit logging
 *
 * Watch for: CSRF headers, large lists, token leakage in CSV
 */

vi.mock("@/lib/api-auth", () => ({
  requireMaintainerSession: vi.fn(),
}));

vi.mock("@/lib/api-key-auth", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api-key-auth")>();
  return {
    ...actual,
    authenticateApiKey: vi.fn(),
    buildRateLimitHeaders: vi.fn().mockReturnValue({}),
    API_KEY_RATE_LIMIT: { windowMs: 60_000, maxRequests: 60 },
  };
});

vi.mock("@/lib/registrations", () => ({
  getContributors: vi.fn(),
}));

vi.mock("@/lib/audit", () => ({
  recordAuditLog: vi.fn(),
}));

vi.mock("@/lib/csv-export", () => ({
  buildContributorsCsv: vi.fn(),
  getContributorsCsvFilename: vi.fn(),
}));

vi.mock("@/lib/csv", () => ({
  buildJson: vi.fn(),
  buildJsonFilename: vi.fn(),
}));

import { GET as csvGET } from "@/app/api/contributors/export/csv/route";
import { GET as jsonGET } from "@/app/api/contributors/export/json/route";
import { requireMaintainerSession } from "@/lib/api-auth";
import { authenticateApiKey } from "@/lib/api-key-auth";
import { getContributors } from "@/lib/registrations";
import { recordAuditLog } from "@/lib/audit";
import { buildContributorsCsv, getContributorsCsvFilename } from "@/lib/csv-export";
import { buildJson, buildJsonFilename } from "@/lib/csv";
import type { ContributorRow } from "@/types";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

function makeContributor(id: string): ContributorRow {
  return {
    id,
    githubUsername: `user-${id}`,
    stellarAddress: `GBBD47GYE3DOE6SXR46LEN4DFSLE3THQ5VS37GAMMA5SMVVSAVOI5TESL`,
    trustlineReady: true,
    trustlineAuthorized: true,
    verified: true,
    funded: true,
    xlmBalance: "100.5",
    spendableXlmBalance: "99.5",
    readiness: "ready" as const,
    lastCheckedAt: "2026-08-26T12:00:00Z",
  };
}

const mockContributors: ContributorRow[] = [
  makeContributor("1"),
  makeContributor("2"),
  makeContributor("3"),
];

function makeRequest(path: string = "/api/contributors/export/csv"): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: "GET",
    headers: {
      host: "localhost:3000",
      "user-agent": "test",
    },
  });
}

const mockSession = {
  user: {
    id: "maintainer-1",
    isMaintainer: true,
    githubUsername: "maintainer",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CSV Export Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contributors/export/csv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Authorization
  // ───────────────────────────────────────────────────────────────────────────

  describe("Authorization", () => {
    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(null);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("denies contributor export before reading or serializing data", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(null);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Unauthorized");
      expect(getContributors).not.toHaveBeenCalled();
      expect(buildContributorsCsv).not.toHaveBeenCalled();
      expect(getContributorsCsvFilename).not.toHaveBeenCalled();
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("allows maintainer access", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: mockContributors.length,
      });
      vi.mocked(buildContributorsCsv).mockReturnValue("id,username\n1,user-1");
      vi.mocked(getContributorsCsvFilename).mockReturnValue(
        "contributors-20260826.csv"
      );

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv;charset=utf-8");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Response Shape
  // ───────────────────────────────────────────────────────────────────────────

  describe("Response Shape", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("returns CSV with correct headers", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });
      vi.mocked(buildContributorsCsv).mockReturnValue(
        "id,githubUsername,stellarAddress,funded,trustlineReady\n" +
        "1,user-1,GBBD...,yes,yes\n" +
        "2,user-2,GBBD...,yes,yes"
      );
      vi.mocked(getContributorsCsvFilename).mockReturnValue(
        "contributors-20260826.csv"
      );

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("text/csv;charset=utf-8");
      expect(res.headers.get("Content-Disposition")).toContain(
        "attachment; filename="
      );
      expect(res.headers.get("Content-Disposition")).toContain(
        "contributors-20260826.csv"
      );
      expect(res.headers.get("Cache-Control")).toBe(
        "no-cache, no-store, must-revalidate"
      );
    });

    it("returns 400 when no contributors exist", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: [],
        total: 0,
      });

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("No contributors to export");
    });

    it("exports contributors with correct field ordering", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });
      const mockCsvData =
        "id,githubUsername,stellarAddress,funded,trustlineReady,trustlineAuthorized,verified,xlmBalance,spendableXlmBalance,readiness,lastCheckedAt,horizonDebugSummary,horizonNextAction,freighterProofChallenge\n" +
        "1,user-1,GBBD47GYE3DOE6SXR46LEN4DFSLE3THQ5VS37GAMMA5SMVVSAVOI5TESL,yes,yes,yes,yes,100.5,99.5,ready,2026-08-26T12:00:00Z,ok,none,challenge-123";
      vi.mocked(buildContributorsCsv).mockReturnValue(mockCsvData);
      vi.mocked(getContributorsCsvFilename).mockReturnValue(
        "contributors-20260826.csv"
      );

      const res = await csvGET(makeRequest());
      const body = await res.text();

      expect(body).toContain("id,githubUsername,stellarAddress");
      expect(buildContributorsCsv).toHaveBeenCalledWith(mockContributors);
    });

    it("does not leak access tokens in CSV", async () => {
      const contributorWithToken: ContributorRow = {
        ...mockContributors[0],
        githubUsername: "test-user",
      };

      vi.mocked(getContributors).mockResolvedValue({
        contributors: [contributorWithToken],
        total: 1,
      });
      vi.mocked(buildContributorsCsv).mockReturnValue(
        "id,githubUsername\n1,test-user"
      );
      vi.mocked(getContributorsCsvFilename).mockReturnValue(
        "contributors-20260826.csv"
      );

      const res = await csvGET(makeRequest());
      const body = await res.text();

      expect(body).not.toMatch(/bearer|token|secret|auth|key/i);
      expect(body).not.toMatch(/\w{40,}/); // No long hex strings (like tokens)
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Audit Logging
  // ───────────────────────────────────────────────────────────────────────────

  describe("Audit Logging", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("records successful export in audit log", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });
      vi.mocked(buildContributorsCsv).mockReturnValue("csv data");
      vi.mocked(getContributorsCsvFilename).mockReturnValue(
        "contributors-20260826.csv"
      );

      await csvGET(makeRequest());

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "export.csv",
          actorId: "maintainer-1",
          actorLogin: "maintainer",
          metadata: expect.objectContaining({
            contributorCount: 3,
            filename: "contributors-20260826.csv",
          }),
        })
      );
    });

    it("records export failure in audit log", async () => {
      vi.mocked(getContributors).mockRejectedValue(
        new Error("Database error")
      );

      await csvGET(makeRequest());

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "export.csv.failed",
          actorId: "maintainer-1",
          metadata: expect.objectContaining({
            error: "Database error",
          }),
        })
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Error Handling
  // ───────────────────────────────────────────────────────────────────────────

  describe("Error Handling", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("returns 500 on database error", async () => {
      vi.mocked(getContributors).mockRejectedValue(
        new Error("Database connection failed")
      );

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Failed to export CSV");
      expect(json.details).toContain("Database connection failed");
    });

    it("handles non-Error exceptions gracefully", async () => {
      vi.mocked(getContributors).mockRejectedValue("unknown error string");

      const res = await csvGET(makeRequest());

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Failed to export CSV");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// JSON Export Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contributors/export/json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Authorization
  // ───────────────────────────────────────────────────────────────────────────

  describe("Authorization", () => {
    it("returns 401 when unauthenticated", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(null);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBe("Unauthorized");
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("denies contributor export before reading or serializing data", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(null);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("Unauthorized");
      expect(getContributors).not.toHaveBeenCalled();
      expect(buildJson).not.toHaveBeenCalled();
      expect(buildJsonFilename).not.toHaveBeenCalled();
      expect(recordAuditLog).not.toHaveBeenCalled();
    });

    it("allows maintainer access", async () => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: mockContributors.length,
      });
      vi.mocked(buildJson).mockReturnValue("[]");
      vi.mocked(buildJsonFilename).mockReturnValue(
        "contributors-20260826.json"
      );

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(
        "application/json;charset=utf-8"
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Response Shape
  // ───────────────────────────────────────────────────────────────────────────

  describe("Response Shape", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("returns JSON with correct headers", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });
      vi.mocked(buildJson).mockReturnValue("[]");
      vi.mocked(buildJsonFilename).mockReturnValue(
        "contributors-20260826.json"
      );

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(
        "application/json;charset=utf-8"
      );
      expect(res.headers.get("Content-Disposition")).toContain(
        "attachment; filename="
      );
      expect(res.headers.get("Content-Disposition")).toContain(
        "contributors-20260826.json"
      );
      expect(res.headers.get("Cache-Control")).toBe(
        "no-cache, no-store, must-revalidate"
      );
    });

    it("returns 400 when no contributors exist", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: [],
        total: 0,
      });

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("No contributors to export");
    });

    it("includes all expected fields in JSON export", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });

      // The actual buildJson call is mocked, but verify the contributor
      // data is passed correctly
      await jsonGET(makeRequest());

      expect(buildJson).toHaveBeenCalled();
      const call = vi.mocked(buildJson).mock.calls[0];
      expect(call[0]).toContain("id");
      expect(call[0]).toContain("githubUsername");
      expect(call[0]).toContain("stellarAddress");
      expect(call[0]).toContain("verified");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Audit Logging
  // ───────────────────────────────────────────────────────────────────────────

  describe("Audit Logging", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("records successful export in audit log", async () => {
      vi.mocked(getContributors).mockResolvedValue({
        contributors: mockContributors,
        total: 3,
      });
      vi.mocked(buildJson).mockReturnValue("[]");
      vi.mocked(buildJsonFilename).mockReturnValue(
        "contributors-20260826.json"
      );

      await jsonGET(makeRequest());

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "export.json",
          actorId: "maintainer-1",
          actorLogin: "maintainer",
          metadata: expect.objectContaining({
            contributorCount: 3,
            filename: "contributors-20260826.json",
          }),
        })
      );
    });

    it("records export failure in audit log", async () => {
      vi.mocked(getContributors).mockRejectedValue(
        new Error("Database error")
      );

      await jsonGET(makeRequest());

      expect(recordAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "export.json.failed",
          actorId: "maintainer-1",
          metadata: expect.objectContaining({
            error: "Database error",
          }),
        })
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Error Handling
  // ───────────────────────────────────────────────────────────────────────────

  describe("Error Handling", () => {
    beforeEach(() => {
      vi.mocked(requireMaintainerSession).mockResolvedValue(mockSession as never);
      vi.mocked(authenticateApiKey).mockResolvedValue(null);
    });

    it("returns 500 on database error", async () => {
      vi.mocked(getContributors).mockRejectedValue(
        new Error("Database connection failed")
      );

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Failed to export JSON");
      expect(json.details).toContain("Database connection failed");
    });

    it("handles non-Error exceptions gracefully", async () => {
      vi.mocked(getContributors).mockRejectedValue("unknown error string");

      const res = await jsonGET(makeRequest());

      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.error).toBe("Failed to export JSON");
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Key Auth — CSV Export
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contributors/export/csv — API key auth", () => {
  const mockApiKey = {
    id: "key-1",
    name: "nightly-cron",
    scopes: ["export:read"],
    createdById: "operator-1",
    maintainerOrgId: "default",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // No browser session
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
  });

  it("returns 200 when a valid export:read API key is provided", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(mockApiKey as never);
    vi.mocked(getContributors).mockResolvedValue({
      contributors: mockContributors,
      total: 3,
    });
    vi.mocked(buildContributorsCsv).mockReturnValue("csv data");
    vi.mocked(getContributorsCsvFilename).mockReturnValue("contributors-20260925.csv");

    const res = await csvGET(makeRequest());

    expect(res.status).toBe(200);
  });

  it("uses api-key:<name> as actorLogin in audit log", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(mockApiKey as never);
    vi.mocked(getContributors).mockResolvedValue({
      contributors: mockContributors,
      total: 3,
    });
    vi.mocked(buildContributorsCsv).mockReturnValue("csv data");
    vi.mocked(getContributorsCsvFilename).mockReturnValue("contributors-20260925.csv");

    await csvGET(makeRequest());

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.csv",
        actorId: "operator-1",
        actorLogin: "api-key:nightly-cron",
      })
    );
  });

  it("returns 429 when the IP is rate-limited", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      rateLimited: true,
      result: { allowed: false, retryAfter: 30, remaining: 0 },
    } as never);

    const res = await csvGET(makeRequest());

    expect(res.status).toBe(429);
  });

  it("returns 401 when the API key is invalid or revoked", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);

    const res = await csvGET(makeRequest());

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// API Key Auth — JSON Export
// ─────────────────────────────────────────────────────────────────────────────

describe("GET /api/contributors/export/json — API key auth", () => {
  const mockApiKey = {
    id: "key-2",
    name: "nightly-json-cron",
    scopes: ["export:read"],
    createdById: "operator-2",
    maintainerOrgId: "default",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requireMaintainerSession).mockResolvedValue(null);
  });

  it("returns 200 when a valid export:read API key is provided", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(mockApiKey as never);
    vi.mocked(getContributors).mockResolvedValue({
      contributors: mockContributors,
      total: 3,
    });
    vi.mocked(buildJson).mockReturnValue("[]");
    vi.mocked(buildJsonFilename).mockReturnValue("contributors-20260925.json");

    const res = await jsonGET(makeRequest("/api/contributors/export/json"));

    expect(res.status).toBe(200);
  });

  it("uses api-key:<name> as actorLogin in audit log", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(mockApiKey as never);
    vi.mocked(getContributors).mockResolvedValue({
      contributors: mockContributors,
      total: 3,
    });
    vi.mocked(buildJson).mockReturnValue("[]");
    vi.mocked(buildJsonFilename).mockReturnValue("contributors-20260925.json");

    await jsonGET(makeRequest("/api/contributors/export/json"));

    expect(recordAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "export.json",
        actorId: "operator-2",
        actorLogin: "api-key:nightly-json-cron",
      })
    );
  });

  it("returns 429 when the IP is rate-limited", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue({
      rateLimited: true,
      result: { allowed: false, retryAfter: 45, remaining: 0 },
    } as never);

    const res = await jsonGET(makeRequest("/api/contributors/export/json"));

    expect(res.status).toBe(429);
  });

  it("returns 401 when the API key is missing or invalid", async () => {
    vi.mocked(authenticateApiKey).mockResolvedValue(null);

    const res = await jsonGET(makeRequest("/api/contributors/export/json"));

    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("Unauthorized");
  });
});
